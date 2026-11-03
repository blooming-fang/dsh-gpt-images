import test, { beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { downloadImage, isPublicAddress } from '../src/download.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const CONFIG = { maxImageBytes: 1024, downloadTimeoutMs: 2000 };
const realHttpRequest = http.request;

// Fail closed: no test can reach external DNS or sockets, including on regressions.
beforeEach(() => {
  mock.method(dns, 'lookup', () => { throw new Error('Unexpected DNS lookup'); });
  mock.method(https, 'request', () => { throw new Error('Unexpected HTTPS request'); });
  mock.method(http, 'request', (url, ...args) => {
    assert.equal(url.hostname, '127.0.0.1', 'Only loopback fixtures may use real sockets');
    return realHttpRequest(url, ...args);
  });
  syncBuiltinESMExports();
});
afterEach(() => {
  mock.restoreAll();
  syncBuiltinESMExports();
});

async function fixture(t, handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req);
    handler(req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  return { base: 'http://127.0.0.1:' + server.address().port, requests };
}

function mockHttps(replies) {
  const calls = [];
  mock.method(https, 'request', (url, options, callback) => {
    const reply = replies[calls.length];
    assert.ok(reply, 'Unexpected redirect/request');
    calls.push({ url, options });
    const req = new EventEmitter();
    req.end = () => queueMicrotask(() => {
      const res = new PassThrough();
      res.statusCode = reply.status ?? 200;
      res.headers = reply.headers ?? {};
      callback(res);
      if (!res.destroyed) res.end(reply.bytes ?? PNG);
    });
    return req;
  });
  syncBuiltinESMExports();
  return calls;
}

function abortError(error) {
  return error.name === 'AbortError' || error.name === 'TimeoutError';
}

test('isPublicAddress retains IPv4/IPv6 private and reserved address protection', () => {
  for (const ip of ['127.0.0.1', '0.0.0.0', '10.1.2.3', '100.64.0.1', '169.254.169.254', '172.16.1.1', '192.168.1.1', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255', '::', '::1', '::ffff:127.0.0.1', '64:ff9b::7f00:1', 'fc00::1', 'fe80::1', 'ff02::1', '2001:db8::1', '2002:7f00:1::', 'not-an-ip']) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) {
    assert.equal(isPublicAddress(ip), true, ip);
  }
});

test('explicit false blocks at entry before URL parsing, DNS, or requests', async () => {
  for (const source of ['not a URL', 'https://images.invalid/a.png', 'http://127.0.0.1/a.png']) {
    await assert.rejects(downloadImage(source, { downloadRemoteImages: false }), /下载已禁用/);
  }
  assert.equal(dns.lookup.mock.callCount(), 0);
  assert.equal(http.request.mock.callCount(), 0);
  assert.equal(https.request.mock.callCount(), 0);
});

test('explicit private-host opt-in uses HTTP; undefined downloadRemoteImages stays compatible', async (t) => {
  const { base, requests } = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': 'remote=secret' });
    res.end(PNG);
  });
  for (const downloadRemoteImages of [true, undefined]) {
    const image = await downloadImage(base + '/image.jpg', {
      ...CONFIG, allowPrivateImageHosts: true, downloadRemoteImages,
      headers: { Authorization: 'Bearer secret', Cookie: 'session=secret' },
      apiKey: 'secret',
    });
    assert.deepEqual(image, { bytes: PNG, mediaType: 'image/png', ext: 'png' });
  }
  assert.equal(requests.length, 2);
  for (const req of requests) {
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers.cookie, undefined);
  }
  assert.equal(https.request.mock.callCount(), 0);
  assert.equal(dns.lookup.mock.callCount(), 0);
});

test('default policy rejects HTTP, non-443 ports, credentials, and private literal hosts before requests', async () => {
  for (const source of ['http://8.8.8.8/a.png', 'ftp://8.8.8.8/a.png', 'https://8.8.8.8:8443/a.png', 'https://127.0.0.1/a.png', 'https://2130706433/a.png', 'https://[::1]/a.png', 'https://[::ffff:127.0.0.1]/a.png', 'https://user:secret@8.8.8.8/a.png']) {
    await assert.rejects(downloadImage(source, CONFIG), /不被允许|已阻止/);
  }
  for (const source of ['http://user:secret@127.0.0.1/a.png', 'https://user:secret@127.0.0.1/a.png', 'file:///image.png']) {
    await assert.rejects(downloadImage(source, { ...CONFIG, allowPrivateImageHosts: true }), (error) => {
      assert.match(error.message, /不被允许/);
      assert.doesNotMatch(error.message, /user|secret/);
      return true;
    });
  }
  assert.equal(dns.lookup.mock.callCount(), 0);
  assert.equal(http.request.mock.callCount(), 0);
  assert.equal(https.request.mock.callCount(), 0);
});

test('DNS must resolve to a nonempty entirely public address set', async () => {
  for (const addresses of [[], [{ address: '127.0.0.1', family: 4 }], [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }]]) {
    mock.method(dns, 'lookup', async () => addresses);
    syncBuiltinESMExports();
    await assert.rejects(downloadImage('https://images.invalid/a.png', CONFIG), /已阻止/);
  }
  assert.equal(https.request.mock.callCount(), 0);
});

test('HTTPS pins checked DNS answers, revalidates redirects, shares signal, and excludes credentials', async () => {
  const pinned = { address: '8.8.8.8', family: 4 };
  mock.method(dns, 'lookup', async (_host, options) => {
    assert.deepEqual(options, { all: true });
    return [pinned];
  });
  const calls = mockHttps([
    { status: 302, headers: { location: 'https://other.invalid/final.png', 'set-cookie': 'session=remote' } },
    {},
  ]);
  const result = await downloadImage('https://images.invalid/start', {
    ...CONFIG, headers: { Authorization: 'Bearer secret', Cookie: 'session=secret' },
  });
  assert.deepEqual(result.bytes, PNG);
  assert.equal(calls.length, 2);
  assert.deepEqual(dns.lookup.mock.calls.map(({ arguments: args }) => args[0]), ['images.invalid', 'other.invalid']);
  assert.equal(calls[0].options.signal, calls[1].options.signal);
  for (const { options } of calls) {
    assert.equal(options.agent, false);
    assert.deepEqual(Object.keys(options.headers).sort(), ['accept', 'user-agent']);
    options.lookup('ignored.invalid', { all: true }, (error, addresses) => {
      assert.equal(error, null);
      assert.deepEqual(addresses, [pinned]);
    });
    options.lookup('ignored.invalid', {}, (error, address, family) => {
      assert.equal(error, null);
      assert.equal(address, pinned.address);
      assert.equal(family, pinned.family);
    });
  }
});

test('public HTTPS redirects cannot bypass private-host, port, protocol, or credential checks', async () => {
  for (const location of ['https://127.0.0.1/secret', 'http://8.8.8.8/image', 'https://8.8.8.8:8443/image', 'https://user:secret@8.8.8.8/image']) {
    const calls = mockHttps([{ status: 302, headers: { location } }]);
    await assert.rejects(downloadImage('https://8.8.8.8/start', CONFIG), /已阻止|不被允许/);
    assert.equal(calls.length, 1);
  }
});

test('redirect hostnames are resolved again and a private DNS answer is blocked', async () => {
  mock.method(dns, 'lookup', async () => [{ address: '10.0.0.1', family: 4 }]);
  const calls = mockHttps([{ status: 302, headers: { location: 'https://internal.invalid/secret' } }]);
  await assert.rejects(downloadImage('https://8.8.8.8/start', CONFIG), /已阻止/);
  assert.equal(dns.lookup.mock.callCount(), 1);
  assert.equal(calls.length, 1);
});

test('private-host opt-in still uses HTTPS requester for HTTPS', async () => {
  const calls = mockHttps([{}]);
  assert.deepEqual((await downloadImage('https://127.0.0.1:8443/image', { ...CONFIG, allowPrivateImageHosts: true })).bytes, PNG);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.protocol, 'https:');
  assert.equal(http.request.mock.callCount(), 0);
});

test('relative redirects work, but missing Location and redirect loops are bounded', async (t) => {
  const { base, requests } = await fixture(t, (req, res) => {
    if (req.url === '/image') return res.end(PNG);
    res.writeHead(302, req.url === '/missing' ? {} : { location: req.url === '/start' ? '/image' : '/loop' });
    res.end();
  });
  const config = { ...CONFIG, allowPrivateImageHosts: true };
  assert.deepEqual((await downloadImage(base + '/start', config)).bytes, PNG);
  await assert.rejects(downloadImage(base + '/missing', config), /重定向无效或次数过多/);
  const beforeLoop = requests.length;
  await assert.rejects(downloadImage(base + '/loop', config), /重定向无效或次数过多/);
  assert.equal(requests.length - beforeLoop, 4);
});

test('HTTP failures, declared/streamed oversize bodies and unsupported image bytes are rejected', async (t) => {
  const { base } = await fixture(t, (req, res) => {
    if (req.url === '/status') { res.writeHead(503); return res.end(); }
    if (req.url === '/length') { res.writeHead(200, { 'content-length': '2048' }); return res.end(); }
    if (req.url === '/stream') { res.writeHead(200, { 'transfer-encoding': 'chunked' }); return res.end(Buffer.alloc(2048)); }
    res.end('not an image');
  });
  const config = { ...CONFIG, allowPrivateImageHosts: true };
  await assert.rejects(downloadImage(base + '/status', config), /HTTP 503/);
  await assert.rejects(downloadImage(base + '/length', config), /大小限制/);
  await assert.rejects(downloadImage(base + '/stream', config), /大小限制/);
  await assert.rejects(downloadImage(base + '/text', config), /不是受支持/);
});

test('redirects and response body share one overall timeout rather than restarting per hop', async (t) => {
  const { base, requests } = await fixture(t, (req, res) => {
    const timer = setTimeout(() => {
      if (req.url === '/start') { res.writeHead(302, { location: '/body' }); res.end(); }
      else res.end(PNG);
    }, 250);
    res.on('close', () => clearTimeout(timer));
  });
  await assert.rejects(downloadImage(base + '/start', {
    ...CONFIG, allowPrivateImageHosts: true, downloadTimeoutMs: 400,
  }), abortError);
  assert.deepEqual(requests.map((req) => req.url), ['/start', '/body']);
});

test('external cancellation propagates after a redirect while streaming the body', async (t) => {
  const controller = new AbortController();
  const reason = new Error('cancelled by caller');
  const { base, requests } = await fixture(t, (req, res) => {
    if (req.url === '/start') { res.writeHead(302, { location: '/body' }); return res.end(); }
    res.writeHead(200);
    res.write(PNG.subarray(0, 8));
    controller.abort(reason);
  });
  await assert.rejects(downloadImage(base + '/start', {
    ...CONFIG, allowPrivateImageHosts: true, signal: controller.signal,
  }), (error) => error.name === 'AbortError' && error.cause === reason);
  assert.equal(requests.length, 2);
});

test('already-aborted caller signal prevents DNS and requests', async () => {
  const reason = new Error('already cancelled');
  await assert.rejects(downloadImage('https://images.invalid/image', {
    ...CONFIG, signal: AbortSignal.abort(reason),
  }), (error) => error === reason);
  assert.equal(dns.lookup.mock.callCount(), 0);
  assert.equal(https.request.mock.callCount(), 0);
});

test('DNS lookup itself honors the overall timeout without starting a request', async () => {
  let timer;
  mock.method(dns, 'lookup', () => new Promise((resolve) => {
    timer = setTimeout(() => resolve([{ address: '8.8.8.8', family: 4 }]), 300);
  }));
  syncBuiltinESMExports();
  try {
    await assert.rejects(downloadImage('https://images.invalid/image', {
      ...CONFIG, downloadTimeoutMs: 30,
    }), (error) => error.name === 'TimeoutError');
    assert.equal(https.request.mock.callCount(), 0);
  } finally {
    clearTimeout(timer);
  }
});
