import test, { beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { IMAGE_API_DEFAULTS, requestImages, validateImageArgs } from '../src/image-api.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const IMAGE = { bytes: PNG, mediaType: 'image/png', filename: 'reference.png' };
const OUTPUT = { data: [{ b64_json: PNG.toString('base64'), mime_type: 'image/png' }] };
const CONFIG = { imageApiBaseURL: 'https://image-api.invalid', imageApiKeyEnv: '', imageTimeoutMs: 1000, maxResponseBytes: 4096, maxImages: 20 };
const ARGS = { prompt: 'draw a small blue circle' };

// Fail closed: even accidental use of the default transport can never reach a real API.
beforeEach(() => { mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected real fetch'); }); });
afterEach(() => { mock.restoreAll(); });

function json(value = OUTPUT, options) {
  return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' }, ...options });
}

function transport(reply = () => json()) {
  const calls = [];
  const fetch = (...args) => { calls.push(args); return reply(...args); };
  return { calls, fetch };
}

function run(config = {}, args = ARGS, options = {}) {
  const wire = transport();
  const promise = requestImages('generate', args, { ...CONFIG, ...config }, { fetch: wire.fetch, ...options });
  return { ...wire, promise };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function code(expected) { return (error) => error.name === 'ImageApiError' && error.code === expected; }

function noSecrets(error) {
  const text = error.stack + JSON.stringify(error);
  assert.doesNotMatch(text, /secret-token|upstream-secret|image-api\.invalid|evil\.invalid/);
  assert.equal(error.cause, undefined);
  return true;
}

test('exports frozen standalone defaults with the exact dedicated endpoint and key environment', () => {
  assert.deepEqual(IMAGE_API_DEFAULTS, {
    imageApiBaseURL: 'http://localhost:8317', imageApiKey: '', imageApiKeyEnv: 'DSH_IMAGE_API_KEY',
    imageModel: 'gpt-image-2.6-flare', imageTimeoutMs: 300000, imageToolsEnabled: true,
  });
  assert.ok(Object.isFrozen(IMAGE_API_DEFAULTS));
});

test('generate sends minimal JSON once and returns extracted Images API candidates', async () => {
  const { promise, calls } = run();
  assert.deepEqual(await promise, { images: [{ base64: PNG.toString('base64'), mediaType: 'image/png' }], model: IMAGE_API_DEFAULTS.imageModel });
  assert.equal(calls.length, 1);
  const [url, options] = calls[0];
  assert.equal(url, 'https://image-api.invalid/v1/images/generations');
  assert.equal(options.method, 'POST');
  assert.equal(options.redirect, 'error');
  assert.deepEqual(options.headers, { Accept: 'application/json', 'Content-Type': 'application/json' });
  assert.deepEqual(JSON.parse(options.body), { ...ARGS, model: IMAGE_API_DEFAULTS.imageModel, n: 1 });
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test('optional supported fields are preserved while URL, key, headers and provider options never cross the wire', async () => {
  const args = { ...ARGS, model: 'custom-image', size: '1536x1024', quality: 'high', n: 2, background: 'transparent', output_format: 'webp' };
  const { promise, calls } = run({ imageModel: 'configured-model' }, {
    ...args, response_format: 'url', stream: true, image_paths: ['private.png'], mask_path: 'private-mask.png',
    apiKey: 'secret-token', imageApiKey: 'secret-token', baseURL: 'https://evil.invalid', imageApiBaseURL: 'https://evil.invalid', headers: { Cookie: 'secret-token' },
  });
  assert.equal((await promise).model, 'custom-image');
  assert.deepEqual(JSON.parse(calls[0][1].body), args);
  assert.equal(calls[0][0], 'https://image-api.invalid/v1/images/generations');
  assert.equal(calls[0][1].headers.Authorization, undefined);
});

test('GIF generation sends numeric frame options exactly as provided', async () => {
  const args = { ...ARGS, output_format: 'gif', frame_count: 8, frame_duration_ms: 100 };
  const { promise, calls } = run({}, args);
  await promise;
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0][1].body), { ...args, model: IMAGE_API_DEFAULTS.imageModel, n: 1 });
});

test('GIF editing sends frame options as multipart fields without altering the input bytes', async () => {
  const wire = transport();
  await requestImages('edit', { ...ARGS, output_format: 'gif', frame_count: 8, frame_duration_ms: 100 }, CONFIG, { fetch: wire.fetch, images: [IMAGE] });
  const form = wire.calls[0][1].body;
  assert.ok(form instanceof FormData);
  assert.equal(form.get('output_format'), 'gif');
  assert.equal(form.get('frame_count'), '8');
  assert.equal(form.get('frame_duration_ms'), '100');
  assert.deepEqual(Buffer.from(await form.get('image').arrayBuffer()), PNG);
  assert.equal(wire.calls[0][1].headers['Content-Type'], undefined);
});

test('GIF always sends default or user-specified frame values and never sends size on either endpoint', async () => {
  const cases = [
    [{ ...ARGS, output_format: 'gif' }, 9, 200],
    [{ ...ARGS, output_format: 'gif', frame_count: 8 }, 8, 200],
    [{ ...ARGS, output_format: 'gif', frame_duration_ms: 100 }, 9, 100],
    [{ ...ARGS, output_format: 'gif', frame_count: 12, frame_duration_ms: 75, size: '1536x1024' }, 12, 75],
    [{ ...ARGS, output_format: 'gif', size: 'auto' }, 9, 200],
    [{ ...ARGS, output_format: 'gif', size: null }, 9, 200],
  ];
  for (const [args, frameCount, duration] of cases) {
    for (const operation of ['generate', 'edit']) {
      const wire = transport();
      await requestImages(operation, args, CONFIG, { fetch: wire.fetch, ...(operation === 'edit' ? { images: [IMAGE] } : {}) });
      const body = operation === 'generate' ? JSON.parse(wire.calls[0][1].body) : Object.fromEntries(wire.calls[0][1].body.entries());
      assert.equal(body.output_format, 'gif');
      assert.equal(body.frame_count, operation === 'generate' ? frameCount : String(frameCount));
      assert.equal(body.frame_duration_ms, operation === 'generate' ? duration : String(duration));
      assert.equal(Object.hasOwn(body, 'size'), false);
    }
  }
});

test('static images preserve optional size and never receive GIF frame defaults', async () => {
  for (const output_format of [undefined, 'png', 'jpeg', 'webp']) {
    for (const size of [undefined, '1536x1024']) {
      for (const operation of ['generate', 'edit']) {
        const wire = transport();
        await requestImages(operation, { ...ARGS, ...(output_format ? { output_format } : {}), ...(size ? { size } : {}) }, CONFIG, { fetch: wire.fetch, ...(operation === 'edit' ? { images: [IMAGE] } : {}) });
        const body = operation === 'generate' ? JSON.parse(wire.calls[0][1].body) : Object.fromEntries(wire.calls[0][1].body.entries());
        assert.equal(body.size, size);
        assert.equal(Object.hasOwn(body, 'frame_count'), false);
        assert.equal(Object.hasOwn(body, 'frame_duration_ms'), false);
      }
    }
  }
});

test('synchronous GIF validation applies only the missing defaults and strips size', () => {
  const fields = validateImageArgs('generate', { ...ARGS, output_format: 'gif', size: '1536x1024' });
  assert.deepEqual(fields, { ...ARGS, model: IMAGE_API_DEFAULTS.imageModel, n: 1, output_format: 'gif', frame_count: 9, frame_duration_ms: 200 });
});

test('invalid animation values or non-GIF combinations fail before either API request', async (t) => {
  for (const operation of ['generate', 'edit']) {
    for (const key of ['frame_count', 'frame_duration_ms']) {
      for (const value of [0, -1, 1.5, '8', null, true, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        await t.test(operation + ' ' + key + '=' + String(value), async () => {
          const wire = transport();
          await assert.rejects(requestImages(operation, { ...ARGS, output_format: 'gif', [key]: value }, CONFIG, { fetch: wire.fetch, images: operation === 'edit' ? [IMAGE] : [] }), code('INVALID_ARGUMENT'));
          assert.equal(wire.calls.length, 0);
        });
      }
      for (const output_format of [undefined, 'png', 'jpeg', 'webp']) {
        const wire = transport();
        await assert.rejects(requestImages(operation, { ...ARGS, ...(output_format ? { output_format } : {}), [key]: 8 }, CONFIG, { fetch: wire.fetch, images: operation === 'edit' ? [IMAGE] : [] }), code('INVALID_ARGUMENT'));
        assert.equal(wire.calls.length, 0);
      }
    }
  }
});

test('configured model is used when no model override is supplied', async () => {
  const { promise, calls } = run({ imageModel: 'configured-model' });
  assert.equal((await promise).model, 'configured-model');
  assert.equal(JSON.parse(calls[0][1].body).model, 'configured-model');
});

test('normalizes only root into /v1 and preserves complete custom mount prefixes', async (t) => {
  const cases = [
    ['http://localhost:8317', 'http://localhost:8317/v1'],
    ['http://127.0.0.1:8317/', 'http://127.0.0.1:8317/v1'],
    ['http://127.20.30.40:8317/v1/', 'http://127.20.30.40:8317/v1'],
    ['http://[::1]:8317/v1', 'http://[::1]:8317/v1'],
    ['https://image-api.invalid/v1', 'https://image-api.invalid/v1'],
    ['https://image-api.invalid/custom/v1///', 'https://image-api.invalid/custom/v1'],
    ['https://image-api.invalid/custom/', 'https://image-api.invalid/custom'],
  ];
  for (const [base, prefix] of cases) await t.test(base, async () => {
    const { promise, calls } = run({ imageApiBaseURL: base });
    await promise;
    assert.equal(calls[0][0], prefix + '/images/generations');
  });
});

test('rejects unsafe base URLs before transport without reflecting credentials or raw URLs', async (t) => {
  for (const base of [
    'http://image-api.invalid', 'http://localhost.evil.invalid', 'http://10.0.0.1', 'http://0.0.0.0',
    'https://secret-token:password@image-api.invalid', 'https://image-api.invalid?key=secret-token',
    'https://image-api.invalid#secret-token', 'https://image-api.invalid?', 'https://image-api.invalid#',
    'ftp://image-api.invalid', 'not a URL secret-token', '',
  ]) await t.test(base.replace(/secret-token/g, 'REDACTED'), async () => {
    const { promise, calls } = run({ imageApiBaseURL: base });
    await assert.rejects(promise, (error) => { assert.ok(code('INVALID_BASE_URL')(error)); return noSecrets(error); });
    assert.equal(calls.length, 0);
  });
});

test('dedicated configured key wins over environment; whitespace-only key falls back to dedicated environment', async (t) => {
  const name = 'DSH_IMAGE_API_OFFLINE_TEST_KEY';
  const previous = process.env[name];
  process.env[name] = 'environment-test-key';
  t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  for (const [imageApiKey, expected] of [[' configured-test-key ', 'configured-test-key'], ['', 'environment-test-key'], ['  ', 'environment-test-key']]) {
    const { promise, calls } = run({ imageApiKey, imageApiKeyEnv: name });
    await promise;
    assert.equal(calls[0][1].headers.Authorization, 'Bearer ' + expected);
  }
});

test('no provider or generic API key is borrowed when dedicated auth is unset', async () => {
  const { promise, calls } = run({ apiKey: 'secret-token', provider: { apiKey: 'secret-token' }, headers: { Authorization: 'secret-token' } });
  await promise;
  assert.equal(calls[0][1].headers.Authorization, undefined);
});

test('default fetch is injectable through globalThis without touching network', async () => {
  globalThis.fetch.mock.mockImplementation(() => json());
  await requestImages('generate', ARGS, CONFIG);
  assert.equal(globalThis.fetch.mock.callCount(), 1);
});

test('edit uses a single image field, optional mask, filename basename and automatic multipart boundary', async () => {
  const wire = transport();
  await requestImages('edit', { ...ARGS, quality: 'high', output_format: 'png' }, CONFIG, {
    fetch: wire.fetch, images: [{ ...IMAGE, filename: 'C:\\private\\reference.png' }], mask: { ...IMAGE, filename: 'mask.png' },
  });
  assert.equal(wire.calls.length, 1);
  const [url, options] = wire.calls[0];
  assert.equal(url, 'https://image-api.invalid/v1/images/edits');
  assert.equal(options.headers['Content-Type'], undefined);
  assert.equal(options.redirect, 'error');
  assert.ok(options.body instanceof FormData);
  assert.deepEqual([...options.body.keys()], ['prompt', 'model', 'n', 'quality', 'output_format', 'image', 'mask']);
  assert.equal(options.body.get('n'), '1');
  assert.equal(options.body.get('image').name, 'reference.png');
  assert.equal(options.body.get('image').type, 'image/png');
  assert.deepEqual(Buffer.from(await options.body.get('image').arrayBuffer()), PNG);
  assert.deepEqual(Buffer.from(await options.body.get('mask').arrayBuffer()), PNG);
  const serialized = new Request(url, { method: 'POST', body: options.body });
  assert.match(serialized.headers.get('content-type'), /^multipart\/form-data; boundary=/);
  assert.match(await serialized.text(), /name="image"; filename="reference.png"/);
});

test('edit uses repeated image[] fields for multiple inputs and no mask unless explicitly provided', async () => {
  const wire = transport();
  await requestImages('edit', ARGS, CONFIG, { fetch: wire.fetch, images: [IMAGE, { ...IMAGE, filename: 'second.png' }] });
  const form = wire.calls[0][1].body;
  assert.equal(form.has('image'), false);
  assert.equal(form.has('mask'), false);
  assert.equal(form.getAll('image[]').length, 2);
  assert.deepEqual(form.getAll('image[]').map((file) => file.name), ['reference.png', 'second.png']);
});

test('rejects missing, oversized, mismatched or SVG edit bytes before transport', async (t) => {
  const cases = [
    { images: [] }, { images: null }, { images: [{ bytes: 'not bytes' }] },
    { images: [{ ...IMAGE, bytes: Buffer.from('<svg>secret-token</svg>') }] },
    { images: [{ ...IMAGE, mediaType: 'image/svg+xml' }] },
    { images: [{ ...IMAGE, mediaType: 'image/jpeg' }] },
    { images: [IMAGE], mask: { ...IMAGE, bytes: Buffer.from('<svg/>') } },
  ];
  for (const options of cases) await t.test(JSON.stringify(options).slice(0, 80), async () => {
    const wire = transport();
    await assert.rejects(requestImages('edit', ARGS, CONFIG, { fetch: wire.fetch, ...options }), code('INVALID_IMAGE'));
    assert.equal(wire.calls.length, 0);
  });
  const wire = transport();
  await assert.rejects(requestImages('edit', ARGS, { ...CONFIG, maxImageBytes: PNG.length - 1 }, { fetch: wire.fetch, images: [IMAGE] }), code('INVALID_IMAGE'));
  await assert.rejects(requestImages('edit', ARGS, { ...CONFIG, maxImages: 1 }, { fetch: wire.fetch, images: [IMAGE, IMAGE] }), code('INVALID_IMAGE'));
  assert.equal(wire.calls.length, 0);
});

test('generate refuses edit inputs and mask rather than silently ignoring them', async () => {
  for (const options of [{ images: [IMAGE] }, { mask: IMAGE }]) {
    const { promise, calls } = run({}, ARGS, options);
    await assert.rejects(promise, code('INVALID_ARGUMENT'));
    assert.equal(calls.length, 0);
  }
});

test('validateImageArgs is synchronous, does no IO and supplies normalized defaults', () => {
  assert.deepEqual(validateImageArgs('edit', { ...ARGS, image_paths: ['private.png'] }, CONFIG), { ...ARGS, n: 1, model: IMAGE_API_DEFAULTS.imageModel });
  assert.equal(globalThis.fetch.mock.callCount(), 0);
  assert.throws(() => validateImageArgs('edit', { prompt: ' ' }, CONFIG), code('INVALID_ARGUMENT'));
});

test('rejects missing prompt, invalid fields, unsupported operation and disabled tools before any request', async (t) => {
  for (const args of [undefined, null, {}, { prompt: '' }, { prompt: ' ' }, { prompt: 42 }, { ...ARGS, model: '' },
    { ...ARGS, size: 12 }, { ...ARGS, quality: null }, { ...ARGS, background: [] }, { ...ARGS, output_format: 'svg' }]) {
    await t.test(JSON.stringify(args) ?? 'undefined', async () => {
      const wire = transport();
      await assert.rejects(requestImages('generate', args, CONFIG, { fetch: wire.fetch }), code('INVALID_ARGUMENT'));
      assert.equal(wire.calls.length, 0);
    });
  }
  const wire = transport();
  await assert.rejects(requestImages('chat', ARGS, CONFIG, { fetch: wire.fetch }), code('INVALID_OPERATION'));
  await assert.rejects(requestImages('generate', ARGS, { ...CONFIG, imageToolsEnabled: false }, { fetch: wire.fetch }), code('TOOLS_DISABLED'));
  assert.equal(wire.calls.length, 0);
});

test('n must be an integer from 1 through min(maxImages, 10)', async () => {
  for (const n of [0, -1, 1.5, '1', NaN, Infinity, 11]) {
    const { promise, calls } = run({}, { ...ARGS, n });
    await assert.rejects(promise, code('INVALID_ARGUMENT'));
    assert.equal(calls.length, 0);
  }
  await assert.rejects(run({ maxImages: 2 }, { ...ARGS, n: 3 }).promise, code('INVALID_ARGUMENT'));
  await run({ maxImages: 2 }, { ...ARGS, n: 2 }).promise;
  await run({}, { ...ARGS, n: 10 }).promise;
});

test('rejects invalid safety limit configuration before transport', async () => {
  for (const config of [{ maxImages: 0 }, { maxResponseBytes: -1 }, { imageTimeoutMs: 0 }, { imageTimeoutMs: 2147483648 }, { imageApiKey: 1 }, { imageApiKeyEnv: null }, { imageApiKey: 'secret-token\r\nx: y' }]) {
    const { promise, calls } = run(config);
    await assert.rejects(promise, (error) => { assert.ok(code('INVALID_CONFIG')(error)); return noSecrets(error); });
    assert.equal(calls.length, 0);
  }
});

test('only direct Images API data entries are extracted, not Chat/Responses or arbitrary nested images', async () => {
  const wire = transport(() => json({
    ...OUTPUT, model: 'untrusted-response-model',
    choices: [{ message: { images: [{ type: 'image_url', image_url: 'https://evil.invalid/chat.png' }] } }],
    output: [{ type: 'image_generation_call', result: 'evil' }],
    data: [...OUTPUT.data, { inlineData: { data: 'evil', mimeType: 'image/png' } }, { content: [{ b64_json: 'evil' }] }],
  }));
  const result = await requestImages('generate', ARGS, CONFIG, { fetch: wire.fetch });
  assert.deepEqual(result.images, [{ base64: PNG.toString('base64'), mediaType: 'image/png' }]);
  assert.equal(result.model, IMAGE_API_DEFAULTS.imageModel);
});

test('accepts direct URL results as candidates without downloading or forwarding credentials', async () => {
  const wire = transport(() => json({ data: [{ url: 'https://image-output.invalid/result.png' }] }));
  assert.deepEqual((await requestImages('generate', ARGS, { ...CONFIG, imageApiKey: 'secret-token' }, { fetch: wire.fetch })).images, [{ url: 'https://image-output.invalid/result.png' }]);
  assert.equal(wire.calls.length, 1);
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test('empty output, non-Images envelopes and unusable URLs are errors rather than silent success', async () => {
  for (const value of [{}, null, [], { data: [] }, { data: [{ b64_json: '' }] }, { data: [{ url: 'file:///private.png' }] }, { output: [{ type: 'image_generation_call', result: PNG.toString('base64') }] }]) {
    const wire = transport(() => json(value));
    await assert.rejects(requestImages('generate', ARGS, CONFIG, { fetch: wire.fetch }), code('NO_IMAGES'));
    assert.equal(wire.calls.length, 1);
  }
});

test('refuses excessive returned image counts', async () => {
  const wire = transport(() => json({ data: [...OUTPUT.data, ...OUTPUT.data] }));
  await assert.rejects(requestImages('generate', ARGS, { ...CONFIG, maxImages: 1 }, { fetch: wire.fetch }), code('TOO_MANY_IMAGES'));
  assert.equal(wire.calls.length, 1);
});

test('non-JSON and empty successful bodies produce a sanitized error without retry', async () => {
  for (const response of [new Response('upstream-secret secret-token https://evil.invalid'), new Response(null, { status: 204 })]) {
    const wire = transport(() => response);
    await assert.rejects(requestImages('generate', ARGS, CONFIG, { fetch: wire.fetch }), (error) => { assert.ok(code('INVALID_RESPONSE')(error)); return noSecrets(error); });
    assert.equal(wire.calls.length, 1);
  }
});

test('response byte limit is enforced for content-length and actual streamed bytes with cancellation', async () => {
  for (const headers of [{ 'content-length': '100' }, {}, { 'content-length': '1' }]) {
    let cancelled = 0;
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(40)); }, cancel() { cancelled++; } });
    const wire = transport(() => new Response(stream, { headers }));
    await assert.rejects(requestImages('generate', ARGS, { ...CONFIG, maxResponseBytes: 30 }, { fetch: wire.fetch }), code('RESPONSE_TOO_LARGE'));
    assert.equal(cancelled, 1);
    assert.equal(wire.calls.length, 1);
  }
});

test('stream limit counts bytes rather than JavaScript characters', async () => {
  const value = JSON.stringify({ ...OUTPUT, comment: '中'.repeat(10) });
  assert.ok(Buffer.byteLength(value) > value.length);
  const wire = transport(() => new Response(value));
  await assert.rejects(requestImages('generate', ARGS, { ...CONFIG, maxResponseBytes: value.length }, { fetch: wire.fetch }), code('RESPONSE_TOO_LARGE'));
});

test('HTTP errors never read upstream body, leak details or retry; 401 identifies dedicated key settings', async (t) => {
  for (const status of [301, 401, 403, 429, 500, 503]) await t.test(String(status), async () => {
    let cancelled = 0;
    const stream = new ReadableStream({ cancel() { cancelled++; } });
    const wire = transport(() => new Response(stream, { status, headers: { location: 'https://evil.invalid?key=secret-token' } }));
    await assert.rejects(requestImages('generate', ARGS, { ...CONFIG, imageApiKey: 'secret-token' }, { fetch: wire.fetch }), (error) => {
      assert.ok(code(status === 401 ? 'UNAUTHORIZED' : 'HTTP_ERROR')(error));
      assert.match(error.message, new RegExp('HTTP ' + status));
      if (status === 401) assert.match(error.message, /imageApiKey.*imageApiKeyEnv/);
      return noSecrets(error);
    });
    assert.equal(cancelled, 1);
    assert.equal(wire.calls.length, 1);
    assert.equal(wire.calls[0][1].redirect, 'error');
  });
});

test('network exceptions, redirect exceptions and forged named errors are sanitized without retries', async () => {
  for (const name of ['TypeError', 'ImageApiError', 'Error']) {
    const wire = transport(() => { const error = new Error('upstream-secret secret-token https://evil.invalid'); error.name = name; throw error; });
    await assert.rejects(requestImages('generate', ARGS, CONFIG, { fetch: wire.fetch }), (error) => { assert.ok(code('REQUEST_FAILED')(error)); return noSecrets(error); });
    assert.equal(wire.calls.length, 1);
  }
});

test('body stream errors are sanitized', async () => {
  const stream = new ReadableStream({ start(controller) { controller.error(new Error('upstream-secret secret-token https://evil.invalid')); } });
  const wire = transport(() => new Response(stream));
  await assert.rejects(requestImages('generate', ARGS, CONFIG, { fetch: wire.fetch }), (error) => { assert.ok(code('REQUEST_FAILED')(error)); return noSecrets(error); });
});

test('an already cancelled request never calls fetch and preserves the original reason', async () => {
  const reason = new Error('caller cancellation');
  const { promise, calls } = run({}, ARGS, { signal: AbortSignal.abort(reason) });
  await assert.rejects(promise, (error) => error === reason);
  assert.equal(calls.length, 0);
});

test('external cancellation during fetch promptly propagates even when an injected transport ignores abort', async () => {
  const controller = new AbortController();
  const reason = new Error('caller cancellation');
  let passedSignal;
  const wire = transport((_url, options) => { passedSignal = options.signal; return new Promise(() => {}); });
  const promise = requestImages('generate', ARGS, CONFIG, { fetch: wire.fetch, signal: controller.signal });
  controller.abort(reason);
  await assert.rejects(promise, (error) => error === reason);
  assert.equal(passedSignal.aborted, true);
  assert.equal(passedSignal.reason, reason);
  assert.equal(wire.calls.length, 1);
});

test('external cancellation during response reading preserves reason and cancels the body', async () => {
  const controller = new AbortController();
  const started = deferred();
  const reason = new Error('caller cancellation');
  let cancelled = 0;
  const stream = new ReadableStream({ pull() { started.resolve(); return new Promise(() => {}); }, cancel() { cancelled++; } });
  const wire = transport(() => new Response(stream));
  const promise = requestImages('generate', ARGS, CONFIG, { fetch: wire.fetch, signal: controller.signal });
  await started.promise;
  controller.abort(reason);
  await assert.rejects(promise, (error) => error === reason);
  assert.equal(cancelled, 1);
});

test('timeout covers waiting for response headers and never retries', async () => {
  let passedSignal;
  const wire = transport((_url, options) => { passedSignal = options.signal; return new Promise(() => {}); });
  await assert.rejects(requestImages('generate', ARGS, { ...CONFIG, imageTimeoutMs: 15 }, { fetch: wire.fetch }), (error) => error.name === 'TimeoutError' && /超时/.test(error.message));
  assert.equal(passedSignal.aborted, true);
  assert.equal(wire.calls.length, 1);
});

test('timeout remains active through body reading and cancels the body', async () => {
  let cancelled = 0;
  const stream = new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { cancelled++; } });
  const wire = transport(() => new Response(stream));
  await assert.rejects(requestImages('generate', ARGS, { ...CONFIG, imageTimeoutMs: 15 }, { fetch: wire.fetch }), (error) => error.name === 'TimeoutError');
  assert.equal(cancelled, 1);
  assert.equal(wire.calls.length, 1);
});

test('late responses from cancellation-ignoring transports are closed', async () => {
  const late = deferred();
  let cancelled = 0;
  const wire = transport(() => late.promise);
  await assert.rejects(requestImages('generate', ARGS, { ...CONFIG, imageTimeoutMs: 15 }, { fetch: wire.fetch }), (error) => error.name === 'TimeoutError');
  late.resolve(new Response(new ReadableStream({ cancel() { cancelled++; } })));
  await Promise.resolve();
  assert.equal(cancelled, 1);
});

test('successful completion clears the timeout rather than aborting a completed transport', async () => {
  const { promise, calls } = run({ imageTimeoutMs: 15 });
  await promise;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls[0][1].signal.aborted, false);
});
