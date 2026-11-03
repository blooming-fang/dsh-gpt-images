import test, { beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import fs from 'node:fs/promises';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createReferenceHandler, REFERENCE_PATH } from '../src/reference.js';
import { readCachedImage, isTrustedImageOrigin } from '../src/reveal.js';

const TOKEN = 'b'.repeat(64);
const LOCAL = 'http://127.0.0.1:54321';
const REMOTE = 'https://dsh.example.test';
const filename = (ext = 'png') => 'generated-' + 'a'.repeat(32) + '.' + ext;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

// A regression must never launch a native action, even when the endpoint is remote.
beforeEach(() => { mock.method(childProcess, 'spawn', () => { throw new Error('Reference must not launch processes'); }); syncBuiltinESMExports(); });
afterEach(() => { mock.restoreAll(); syncBuiltinESMExports(); });

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-reference-'));
  const cacheDir = join(root, 'cache'); await mkdir(cacheDir);
  const file = join(cacheDir, filename()); await writeFile(file, PNG);
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { cacheDir, maxImageBytes: 1024, ...overrides.config };
  const services = { token: TOKEN, origins: () => [LOCAL, REMOTE + '/reverse/proxy/'], ...overrides.services };
  return { root, cacheDir, file, config, services, handler: createReferenceHandler(config, services) };
}

async function invoke(handler, input = { filename: filename() }, options = {}) {
  const req = options.req ?? Readable.from(options.chunks ?? [options.bytes ?? Buffer.from(JSON.stringify(input))]);
  req.method = options.method ?? 'POST'; req.url = options.url ?? REFERENCE_PATH;
  req.headers = { origin: REMOTE, 'content-type': 'application/json', 'x-dsh-gpt-images-token': TOKEN, ...options.headers };
  req.socket = { remoteAddress: options.remoteAddress ?? '203.0.113.10' };
  const res = new EventEmitter();
  Object.assign(res, { destroyed: false, writableEnded: false });
  const result = { status: undefined, headers: {}, bytes: undefined, body: undefined, req, res };
  res.writeHead = (status, headers) => { result.status = status; result.headers = headers; };
  res.end = (bytes) => { result.bytes = bytes; res.writableEnded = true; };
  options.onResponse?.(res);
  await handler(req, res);
  if (result.status !== undefined) {
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.equal(result.headers['x-content-type-options'], 'nosniff');
    if (result.headers['content-type'].startsWith('application/json') && result.bytes !== undefined) result.body = JSON.parse(result.bytes);
    if (result.body) assert.ok(!String(result.bytes).includes(TOKEN), 'secret token leaked');
  }
  assert.equal(res.listenerCount('close'), 0, 'response listener leaked');
  assert.equal(req.listenerCount('aborted'), 0, 'abort listener leaked');
  return result;
}

test('fixed endpoint and sufficiently strong tokens are required', () => {
  assert.equal(REFERENCE_PATH, '/dsh-gpt-images/reference');
  for (const token of [undefined, '', 'short', 'a'.repeat(513), 'a'.repeat(40) + '\n']) {
    assert.throws(() => createReferenceHandler({}, { token }), /令牌无效/);
  }
});

test('remote trusted page receives exact binary bytes, signature MIME and length without native effects', async (t) => {
  const f = await fixture(t);
  const result = await invoke(f.handler);
  assert.equal(result.status, 200);
  assert.ok(Buffer.isBuffer(result.bytes), 'binary Buffer, not base64 JSON');
  assert.deepEqual(result.bytes, PNG);
  assert.equal(result.headers['content-type'], 'image/png');
  assert.equal(result.headers['content-length'], PNG.length);
  assert.equal(result.headers['access-control-allow-origin'], REMOTE);
  assert.match(result.headers['content-security-policy'], /sandbox/);
  assert.equal(result.headers['access-control-allow-credentials'], undefined);
  assert.equal(childProcess.spawn.mock.callCount(), 0);
});

test('all supported signatures preserve exact bytes and matching MIME', async (t) => {
  const f = await fixture(t);
  for (const [ext, bytes, mediaType] of [
    ['png', PNG, 'image/png'], ['jpg', Buffer.from([255, 216, 255, 0]), 'image/jpeg'],
    ['webp', Buffer.from('RIFF0000WEBP'), 'image/webp'], ['gif', Buffer.from('GIF89a'), 'image/gif'],
  ]) {
    await writeFile(join(f.cacheDir, filename(ext)), bytes);
    const result = await invoke(f.handler, { filename: filename(ext) });
    assert.equal(result.status, 200);
    assert.deepEqual(result.bytes, bytes);
    assert.equal(result.headers['content-type'], mediaType);
    assert.equal(result.headers['content-length'], bytes.length);
  }
});

test('shared cache helper returns bytes/file/MIME, rejects arbitrary names, and sanitizes filesystem errors', async (t) => {
  const f = await fixture(t);
  const image = await readCachedImage(f.config, filename());
  assert.deepEqual(image, { bytes: PNG, file: f.file, mediaType: 'image/png' });
  for (const name of ['../' + filename(), f.file, 'https://evil.test/x.png', filename() + '\n', undefined]) {
    await assert.rejects(readCachedImage(f.config, name), (error) => error.message === '图片缓存不可用。');
  }
  await rm(f.file);
  await assert.rejects(readCachedImage(f.config, filename()), (error) => !error.message.includes(f.root));
});

test('POST requires the current nonce for local, remote and Electron origins', async (t) => {
  const f = await fixture(t);
  for (const origin of [LOCAL, REMOTE, 'dsh-app://desktop']) {
    for (const token of [undefined, '', 'old', 'a'.repeat(64), [TOKEN]]) {
      const result = await invoke(f.handler, undefined, { headers: { origin, 'x-dsh-gpt-images-token': token } });
      assert.equal(result.status, 403);
      assert.equal(result.body.ok, false);
    }
  }
  assert.equal(childProcess.spawn.mock.callCount(), 0);
});

test('Origins match only configured HTTP(S) origins, not arbitrary loopback or path-bearing browser Origin', async (t) => {
  const f = await fixture(t);
  for (const origin of [undefined, 'null', 'https://evil.test', 'http://127.0.0.1:1', 'http://localhost:54321', REMOTE + '/', REMOTE + '/reverse/proxy', REMOTE + '?secret=1', REMOTE + '#hash', 'https://user:pass@dsh.example.test', REMOTE + ', https://evil.test']) {
    const result = await invoke(f.handler, undefined, { headers: { origin } });
    assert.equal(result.status, 403, String(origin));
    assert.equal(result.headers['access-control-allow-origin'], undefined);
  }
  assert.equal((await invoke(f.handler, undefined, { headers: { origin: LOCAL } })).status, 200);
});

test('origin helper handles configured base paths, strict custom scheme serialization and invalid configuration', () => {
  assert.equal(isTrustedImageOrigin(REMOTE, [REMOTE + '/base/path/']), true);
  for (const allowed of [[REMOTE + '?x=1'], [REMOTE + '#x'], ['https://user:pass@dsh.example.test'], ['file:///tmp'], ['null'], 'not-an-array']) {
    assert.equal(isTrustedImageOrigin(REMOTE, allowed), false);
  }
  for (const origin of ['dsh-app://app', 'dsh-app://desktop', 'dsh-app://desktop/']) assert.equal(isTrustedImageOrigin(origin, []), true);
  for (const origin of ['dsh-app:', 'dsh-app://', 'dsh-app:///app', 'dsh-app://user:pass@app', 'dsh-app://app/path', 'dsh-app://app?x=1', 'dsh-app://app#x', 'null']) assert.equal(isTrustedImageOrigin(origin, []), false);
});

test('configured origins are refreshed per request and configuration failures fail closed', async (t) => {
  let allowed = [REMOTE];
  const f = await fixture(t, { services: { origins: () => allowed } });
  assert.equal((await invoke(f.handler)).status, 200);
  allowed = [LOCAL];
  assert.equal((await invoke(f.handler)).status, 403);
  const broken = createReferenceHandler(f.config, { token: TOKEN, origins: () => { throw new Error('private config path'); } });
  const result = await invoke(broken);
  assert.equal(result.status, 403); assert.ok(!String(result.bytes).includes('private'));
});

test('safe CORS preflight works for remote and Electron without requiring the actual nonce', async (t) => {
  const f = await fixture(t);
  for (const origin of [REMOTE, 'dsh-app://desktop']) {
    const result = await invoke(f.handler, undefined, { method: 'OPTIONS', headers: { origin, 'x-dsh-gpt-images-token': undefined, 'access-control-request-method': 'POST', 'access-control-request-headers': 'Content-Type, X-DSH-GPT-Images-Token' } });
    assert.equal(result.status, 204); assert.equal(result.bytes, undefined);
    assert.equal(result.headers['access-control-allow-origin'], origin);
    assert.equal(result.headers['access-control-allow-methods'], 'POST');
    assert.equal(result.headers['access-control-allow-credentials'], undefined);
  }
});

test('preflight rejects external origins, methods and unapproved headers', async (t) => {
  const f = await fixture(t);
  const headers = { 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type, x-dsh-gpt-images-token' };
  for (const change of [{ origin: 'https://evil.test' }, { origin: 'null' }, { 'access-control-request-method': 'DELETE' }, { 'access-control-request-headers': 'authorization' }]) {
    const result = await invoke(f.handler, undefined, { method: 'OPTIONS', headers: { ...headers, ...change } });
    assert.equal(result.status, 403);
    assert.equal(result.headers['access-control-allow-origin'], undefined);
  }
});

test('only filename is accepted: path/URL/extra fields and traversal are never trusted', async (t) => {
  const f = await fixture(t);
  for (const input of [null, [], {}, { filename: filename(), path: f.file }, { filename: filename(), url: REMOTE + '/image' }, { filename: filename(), extra: true }, { filename: '../' + filename() }, { filename: f.file }, { filename: filename() + '\n' }, { filename: filename().toUpperCase() }, { filename: 'https://evil.test/image.png' }, { filename: filename('svg') }]) {
    const result = await invoke(f.handler, input);
    assert.equal(result.status, 400);
    assert.deepEqual(Object.keys(result.body).sort(), ['message', 'ok']);
    assert.ok(!String(result.bytes).includes(f.root));
  }
});

test('JSON media type, strict UTF8 and both declared and actual 4096-byte body limits are enforced', async (t) => {
  const f = await fixture(t);
  for (const bytes of [Buffer.from('{'), Buffer.from(''), Buffer.from([0xff])]) assert.equal((await invoke(f.handler, undefined, { bytes })).status, 400);
  assert.equal((await invoke(f.handler, undefined, { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await invoke(f.handler, undefined, { headers: { 'content-length': '4097' } })).status, 413);
  assert.equal((await invoke(f.handler, undefined, { chunks: [Buffer.alloc(3000, 'x'), Buffer.alloc(2000, 'y')] })).status, 413);
  const exact = Buffer.from(JSON.stringify({ filename: filename() }).padEnd(4096, ' '));
  assert.equal((await invoke(f.handler, undefined, { bytes: exact, headers: { 'content-length': '4096' } })).status, 200);
});

test('wrong route and unsupported methods return fixed JSON errors', async (t) => {
  const f = await fixture(t);
  assert.equal((await invoke(f.handler, undefined, { url: '/different' })).status, 404);
  assert.equal((await invoke(f.handler, undefined, { method: 'GET' })).status, 405);
  assert.equal((await invoke(f.handler, undefined, { method: 'HEAD' })).status, 405);
});

test('missing, oversized, empty, non-image, wrong-extension and non-file cache entries never return bytes', async (t) => {
  for (const kind of ['missing', 'oversize', 'empty', 'text', 'wrong-extension', 'directory']) {
    const f = await fixture(t); await rm(f.file);
    let name = filename();
    if (kind === 'oversize') await writeFile(f.file, Buffer.alloc(1025));
    if (kind === 'empty') await writeFile(f.file, Buffer.alloc(0));
    if (kind === 'text') await writeFile(f.file, Buffer.from('private text, not an image'));
    if (kind === 'wrong-extension') { name = filename('jpg'); await writeFile(join(f.cacheDir, name), PNG); }
    if (kind === 'directory') await mkdir(f.file);
    const result = await invoke(f.handler, { filename: name });
    assert.equal(result.status, 404, kind);
    assert.deepEqual(Object.keys(result.body).sort(), ['message', 'ok']);
    assert.ok(!String(result.bytes).includes(f.root));
  }
});

test('configured image byte limit is honored by the shared cache reader', async (t) => {
  const f = await fixture(t, { config: { maxImageBytes: PNG.length - 1 } });
  assert.equal((await invoke(f.handler)).status, 404);
});

test('cache ancestor junction/symlink and image leaf symlink are rejected', async (t) => {
  const f = await fixture(t);
  const alias = join(f.root, 'cache-alias');
  await symlink(f.cacheDir, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const aliased = createReferenceHandler({ ...f.config, cacheDir: alias }, f.services);
  assert.equal((await invoke(aliased)).status, 404);
  const outside = join(f.root, filename()); await writeFile(outside, PNG); await rm(f.file);
  try { await symlink(outside, f.file, 'file'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('Host does not permit file symlinks'); throw error; }
  assert.equal((await invoke(f.handler)).status, 404);
});

test('identity changes while opening the cache fail closed and close file handles', async (t) => {
  const f = await fixture(t);
  const originalOpen = fs.open;
  const handles = [];
  const spy = t.mock.method(fs, 'open', async (...args) => {
    await writeFile(f.file, Buffer.concat([PNG, Buffer.from('changed')]));
    const handle = await originalOpen(...args); handles.push(handle); return handle;
  });
  syncBuiltinESMExports();
  try {
    assert.equal((await invoke(f.handler)).status, 404);
    assert.ok(handles.every((handle) => handle.fd === -1));
  } finally { spy.mock.restore(); syncBuiltinESMExports(); }
});

test('request timeout is bounded and produces a safe 408 response', async (t) => {
  const f = await fixture(t);
  t.mock.method(globalThis, 'setTimeout', (fn, ms) => { assert.equal(ms, 5000); queueMicrotask(fn); return { unref() {} }; });
  t.mock.method(globalThis, 'clearTimeout', () => {});
  const req = new Readable({ read() {} });
  try { assert.equal((await invoke(f.handler, undefined, { req })).status, 408); }
  finally { req.destroy(); }
});

test('aborted request and subsequent ECONNRESET do not throw or return image bytes', async (t) => {
  const f = await fixture(t);
  const req = new Readable({ read() { queueMicrotask(() => { this.emit('aborted'); queueMicrotask(() => this.emit('error', new Error('reset'))); }); } });
  const result = await invoke(f.handler, undefined, { req });
  await Promise.resolve();
  assert.equal(result.status, undefined);
  assert.equal(result.bytes, undefined);
});

test('disconnect during cache read prevents any binary response or native side effect', async (t) => {
  const f = await fixture(t);
  const originalOpen = fs.open;
  let response;
  const spy = t.mock.method(fs, 'open', async (...args) => { response.destroyed = true; response.emit('close'); return originalOpen(...args); });
  syncBuiltinESMExports();
  try {
    const result = await invoke(f.handler, undefined, { onResponse: (res) => { response = res; } });
    assert.equal(result.status, undefined); assert.equal(result.bytes, undefined);
    assert.equal(childProcess.spawn.mock.callCount(), 0);
  } finally { spy.mock.restore(); syncBuiltinESMExports(); }
});
