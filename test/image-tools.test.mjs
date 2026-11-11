import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { registerImageTools, IMAGE_TOOL_OUTPUT } from '../src/image-tools.js';
import { IMAGE_API_DEFAULTS } from '../src/image-api.js';
import { DEFAULTS } from '../src/bridge.js';
import { createRecentSet } from '../src/storage.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5N8AAAAASUVORK5CYII=', 'base64');
const JPEG = Buffer.from([255, 216, 255, 217]);
const result = () => ({ model: 'gpt-image-2.6-flare', images: [{ base64: PNG.toString('base64') }] });
async function fixture(t, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-image-tools-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'current'); await mkdir(cwd);
  const config = { ...DEFAULTS, ...IMAGE_API_DEFAULTS, cacheDir: join(root, 'cache'), ...extra };
  const definitions = new Map(); const requests = []; const reads = [];
  const agent = { id: 'session-a', session: { header: { cwd: join(root, 'original') } } };
  const exec = { agent, signal: new AbortController().signal };
  const fs = {
    async resolve(path, opts) { reads.push({ path, opts }); return { displayPath: resolve(opts.cwd || cwd, path) }; },
    async stat(target) { try { const s = await stat(target.displayPath); return { type: s.isFile() ? 'file' : 'directory', size: s.size }; } catch { return undefined; } },
    async readBytes(target, signal, limit) { signal?.throwIfAborted(); const bytes = await readFile(target.displayPath); if (bytes.length > limit) throw new Error('FS_TOO_LARGE'); return bytes; },
  };
  const registry = { register(def) { definitions.set(def.name, def); }, get: (name) => definitions.get(name) };
  const ctx = { tools: registry, fs, workingDirectory: { async ensure(owner, signal) { assert.equal(owner, exec.agent); assert.equal(signal, exec.signal); return cwd; } }, get(name) { return this[name]; } };
  const services = { cacheDirectory: config.cacheDir, recent: createRecentSet(), baseURL: () => 'http://127.0.0.1:61495/', async requestImages(...args) { requests.push(args); return result(); } };
  registerImageTools(ctx, config, services);
  return { root, cwd, config, ctx, services, definitions, requests, reads, exec, generate: definitions.get('generate_image'), edit: definitions.get('edit_image') };
}

test('exactly two raw-schema tools expose no credential or endpoint arguments', async (t) => {
  const f = await fixture(t);
  assert.deepEqual([...f.definitions.keys()], ['generate_image', 'edit_image']);
  for (const def of f.definitions.values()) {
    assert.equal(def.parameters.additionalProperties, false);
    assert.equal(def.output.schema, IMAGE_TOOL_OUTPUT);
    assert.equal(def.isConcurrencySafe, undefined);
    assert.equal(def.timeoutMs, f.config.imageTimeoutMs + f.config.downloadTimeoutMs * 10 + 30000);
    assert.equal(def.parameters.properties.imageApiKey, undefined);
    assert.equal(def.parameters.properties.imageApiBaseURL, undefined);
    assert.match(def.description, /Do not automatically retry/);
  }
});

test('raw input/output schemas stay within the installed host supported subset', async (t) => {
  const f = await fixture(t);
  const allowed = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'title', 'description', 'default', 'deprecated', 'examples']);
  function check(schema) {
    for (const key of Object.keys(schema)) assert.ok(allowed.has(key), 'Unsupported schema keyword: ' + key);
    for (const child of Object.values(schema.properties || {})) check(child);
    if (schema.items) check(schema.items);
    for (const child of schema.oneOf || []) check(child);
  }
  for (const def of f.definitions.values()) { check(def.parameters); check(def.output.schema); }
});

test('disabled tools do not register; collisions fail before either registration', () => {
  const names = [];
  registerImageTools({ tools: { register: (d) => names.push(d.name) } }, { imageToolsEnabled: false }, {});
  assert.deepEqual(names, []);
  assert.throws(() => registerImageTools({ tools: { get: (n) => n === 'edit_image' ? {} : undefined, register: (d) => names.push(d.name) } }, {}, {}), /命名冲突/);
  assert.deepEqual(names, []);
});

test('generation saves both copies to current projected cwd and produces gallery-compatible markdown', async (t) => {
  const f = await fixture(t);
  const value = await f.generate.execute({ prompt: '产品海报' }, f.exec);
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0][0], 'generate');
  assert.equal(f.requests[0][3].signal, f.exec.signal);
  assert.equal(value.images.length, 1); assert.deepEqual(value.warnings, []);
  const image = value.images[0];
  assert.equal(image.path, join(f.cwd, image.filename));
  assert.equal(image.cachePath, join(f.config.cacheDir, image.filename));
  assert.deepEqual(await readFile(image.path), PNG); assert.deepEqual(await readFile(image.cachePath), PNG);
  assert.match(value.markdown, /!\[生成的图片 1\]/);
  assert.match(value.markdown, /dsh-gpt-images\/generated-/);
  assert.match(image.url, /^http:\/\/127[.]0[.]0[.]1:61495/);
  assert.equal(new URL(image.url).searchParams.get('dgi_path'), image.path.replaceAll(String.fromCharCode(92), '/'));
  assert.ok(value.markdown.includes(image.url));
  assert.equal(image.sha256, undefined);
  assert.equal(JSON.stringify(value).includes('imageApiKey'), false);
  assert.deepEqual(f.generate.output.render({}, value), [{ type: 'text', text: value.markdown }]);
});

test('editing reads original bytes through fs using current cwd and forwards optional PNG mask', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.cwd, 'reference space.png'), PNG); await writeFile(join(f.cwd, 'mask.png'), PNG);
  const value = await f.edit.execute({ prompt: '只改背景', image_paths: ['reference space.png'], mask_path: 'mask.png' }, f.exec);
  assert.equal(value.images.length, 1); assert.equal(f.requests.length, 1);
  const [operation, args, config, inputs] = f.requests[0];
  assert.equal(operation, 'edit'); assert.equal(args.prompt, '只改背景'); assert.equal(config, f.config);
  assert.deepEqual(inputs.images[0].bytes, PNG); assert.deepEqual(inputs.mask.bytes, PNG);
  assert.equal(inputs.images[0].mediaType, 'image/png'); assert.equal(inputs.mask.filename, 'mask.png');
  assert.equal(f.reads.length, 2); assert.equal(f.reads[0].opts.cwd, f.cwd);
});

test('both tools advertise GIF parameters and preserve animated GIF response bytes', async (t) => {
  const f = await fixture(t);
  // A two-frame, 1x1 GIF89a fixture, including loop and per-frame timing blocks.
  const gif = Buffer.from('47494638396101000100800000000000ffffff21ff0b4e45545343415045322e30030100000021f904000a0000002c000000000100010000020244010021f904000a0000002c00000000010001000002024c01003b', 'hex');
  f.services.requestImages = async (operation, args, config, inputs) => {
    f.requests.push([operation, args, config, inputs]);
    return { model: 'fixture-gif', images: [{ base64: gif.toString('base64'), mediaType: 'image/gif' }] };
  };
  await writeFile(join(f.cwd, 'reference.gif'), gif);
  for (const [name, def] of [['generate', f.generate], ['edit', f.edit]]) {
    assert.ok(def.parameters.properties.output_format.enum.includes('gif'));
    assert.equal(def.parameters.properties.frame_count.type, 'integer');
    assert.equal(def.parameters.properties.frame_duration_ms.type, 'integer');
    assert.equal(def.parameters.required.includes('frame_count'), false);
    assert.equal(def.parameters.required.includes('frame_duration_ms'), false);
    const args = { prompt: '海边动画', output_format: 'gif', frame_count: 8, frame_duration_ms: 100, ...(name === 'edit' ? { image_paths: ['reference.gif'] } : {}) };
    const value = await def.execute(args, f.exec);
    const image = value.images[0];
    assert.equal(image.mediaType, 'image/gif');
    assert.ok(image.filename.endsWith('.gif'));
    assert.deepEqual(await readFile(image.path), gif);
    assert.deepEqual(await readFile(image.cachePath), gif);
    assert.match(value.markdown, /[.]gif/);
    assert.deepEqual(f.requests.at(-1)[1], args);
  }
  assert.deepEqual(f.requests[1][3].images[0].bytes, gif);
});

test('GIF tool schemas describe defaults and ignore size before validating remaining fields', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.cwd, 'reference.png'), PNG);
  for (const def of [f.generate, f.edit]) {
    assert.match(def.parameters.properties.frame_count.description, /默认9/);
    assert.match(def.parameters.properties.frame_duration_ms.description, /默认200/);
    assert.match(def.parameters.properties.size.description, /GIF不需要size/);
    const args = { prompt: '海浪动画', output_format: 'gif', size: null, ...(def === f.edit ? { image_paths: ['reference.png'] } : {}) };
    await def.execute(args, f.exec);
  }
  assert.equal(f.requests.length, 2);
});

test('invalid animation arguments are rejected before reading edit files', async (t) => {
  const f = await fixture(t);
  for (const def of [f.generate, f.edit]) {
    const files = def === f.edit ? { image_paths: ['never-read.png'] } : {};
    for (const args of [
      { output_format: 'gif', frame_count: 0 },
      { output_format: 'gif', frame_duration_ms: null },
      { output_format: 'gif', frame_count: 1.5 },
      { output_format: 'gif', frame_duration_ms: '100' },
      { output_format: 'png', frame_count: 8 },
      { frame_duration_ms: 100 },
    ]) await assert.rejects(() => def.execute({ prompt: 'x', ...files, ...args }, f.exec));
  }
  assert.equal(f.reads.length, 0);
  assert.equal(f.requests.length, 0);
});

test('strict invalid input is rejected before file reads or HTTP', async (t) => {
  const f = await fixture(t);
  for (const args of [null, {}, { prompt: '' }, { prompt: 'x', model: null }, { prompt: 'x', n: null }, { prompt: 'x', n: 0 }, { prompt: 'x', n: 11 }, { prompt: 'x', quality: 'bad' }, { prompt: 'x', background: 'bad' }, { prompt: 'x', imageApiKey: 'do-not-leak' }, { prompt: 'x', output_format: 'svg' }]) {
    await assert.rejects(() => f.generate.execute(args, f.exec));
  }
  for (const image_paths of [undefined, [], [''], [1], ['https://private.invalid/image.png'], ['data:image/png;base64,abc'], ['a'.repeat(1) + String.fromCharCode(0)]]) {
    await assert.rejects(() => f.edit.execute({ prompt: 'x', image_paths }, f.exec));
  }
  await assert.rejects(() => f.edit.execute({ prompt: 'x', image_paths: ['a'], mask_path: '' }, f.exec));
  assert.equal(f.requests.length, 0); assert.equal(f.reads.length, 0);
});

test('missing fs or working-directory refusal never falls back to direct Node reads or original cwd', async (t) => {
  const f = await fixture(t); f.ctx.fs = undefined;
  await assert.rejects(() => f.edit.execute({ prompt: 'x', image_paths: ['x.png'] }, f.exec), /fs/);
  f.ctx.workingDirectory.ensure = async () => { throw new Error('workspace refused'); };
  await assert.rejects(() => f.generate.execute({ prompt: 'x' }, f.exec), /workspace refused/);
  assert.equal(f.requests.length, 0);
});

test('bad files, directory, oversize bytes, fs refusal and non-PNG mask prevent network calls', async (t) => {
  const f = await fixture(t, { maxImageBytes: PNG.length });
  await writeFile(join(f.cwd, 'text.png'), 'not image'); await writeFile(join(f.cwd, 'large.png'), Buffer.alloc(PNG.length + 1));
  await writeFile(join(f.cwd, 'good.png'), PNG); await writeFile(join(f.cwd, 'mask.jpg'), JPEG);
  for (const path of ['missing.png', '.', 'text.png', 'large.png']) {
    await assert.rejects(() => f.edit.execute({ prompt: 'x', image_paths: [path] }, f.exec));
  }
  await assert.rejects(() => f.edit.execute({ prompt: 'x', image_paths: ['good.png'], mask_path: 'mask.jpg' }, f.exec), /PNG/);
  f.ctx.fs.readBytes = async () => { throw new Error('FS_SANDBOX_DENIED'); };
  await assert.rejects(() => f.edit.execute({ prompt: 'x', image_paths: ['good.png'] }, f.exec), /FS_SANDBOX_DENIED/);
  assert.equal(f.requests.length, 0);
});

test('aggregate reference input cap applies even when each file is within its individual cap', async (t) => {
  const f = await fixture(t, { maxImageBytes: PNG.length, maxResponseBytes: PNG.length + 1 });
  await writeFile(join(f.cwd, 'a.png'), PNG); await writeFile(join(f.cwd, 'b.png'), PNG);
  await assert.rejects(() => f.edit.execute({ prompt: 'x', image_paths: ['a.png', 'b.png'] }, f.exec));
  assert.equal(f.requests.length, 0);
});

test('explicit session required, cancellation forwarded, and canceled response is not saved or retried', async (t) => {
  const f = await fixture(t);
  await assert.rejects(() => f.generate.execute({ prompt: 'x' }, { signal: f.exec.signal }), /会话/);
  const controller = new AbortController(); f.exec.signal = controller.signal; controller.abort(new Error('cancel'));
  await assert.rejects(() => f.generate.execute({ prompt: 'x' }, f.exec), /cancel/); assert.equal(f.requests.length, 0);
  const c = new AbortController(); f.exec.signal = c.signal;
  f.services.requestImages = async () => { c.abort(new Error('after HTTP')); return result(); };
  await assert.rejects(() => f.generate.execute({ prompt: 'x' }, f.exec), /after HTTP/);
  await assert.rejects(() => stat(f.config.cacheDir), { code: 'ENOENT' });
});

test('storage reuse stays per session and repeated image tools still return a visible result', async (t) => {
  const f = await fixture(t);
  const a = await f.generate.execute({ prompt: 'x' }, f.exec);
  const b = await f.generate.execute({ prompt: 'x' }, f.exec);
  assert.equal(a.images[0].filename, b.images[0].filename); assert.ok(b.markdown);
  f.exec.agent = { ...f.exec.agent, id: 'session-b' };
  const c = await f.generate.execute({ prompt: 'x' }, f.exec);
  assert.notEqual(c.images[0].filename, a.images[0].filename); assert.equal(f.requests.length, 3);
});

test('legacy header cwd and explicit output directory remain supported; unknown cwd is cache-only', async (t) => {
  const f = await fixture(t, { outputDir: 'images', subdirectory: 'nested' });
  f.ctx.workingDirectory = undefined; f.exec.agent.session.header.cwd = f.cwd;
  const a = await f.generate.execute({ prompt: 'x' }, f.exec);
  assert.equal(a.images[0].path, join(f.cwd, 'images', 'nested', a.images[0].filename));
  delete f.exec.agent.session.header.cwd;
  const b = await f.generate.execute({ prompt: 'x' }, f.exec);
  assert.equal(b.images[0].path, undefined); assert.ok(b.images[0].cachePath);
  assert.match(b.warnings.join(' '), /无法确定会话当前目录/);
});

test('save/decode failure does not claim success or retry; partial success preserves warnings', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  f.services.requestImages = async () => { calls++; return { model: 'fixture', images: [{ base64: 'not image' }] }; };
  await assert.rejects(() => f.generate.execute({ prompt: 'x' }, f.exec), /未能保存任何图片/); assert.equal(calls, 1);
  f.services.requestImages = async () => ({ model: 'fixture', images: [...result().images, { base64: 'bad' }] });
  const value = await f.generate.execute({ prompt: 'x' }, f.exec);
  assert.equal(value.images.length, 1); assert.ok(value.warnings.length); assert.match(value.markdown, /图片处理提示/);
});

test('real HTTP fixture covers JSON generation and multipart editing without external model calls', async (t) => {
  const f = await fixture(t);
  const received = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    received.push({ url: req.url, type: req.headers['content-type'], auth: req.headers.authorization, body: Buffer.concat(chunks) });
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise((done) => { server.closeAllConnections(); server.close(done); }));
  f.config.imageApiBaseURL = 'http://127.0.0.1:' + server.address().port;
  f.config.imageApiKey = 'fixture-only'; delete f.services.requestImages;
  const generated = await f.generate.execute({ prompt: '画一个蓝色圆形' }, f.exec);
  await f.edit.execute({ prompt: '改成红色', image_paths: [generated.images[0].path] }, f.exec);
  assert.equal(received.length, 2); assert.equal(received[0].url, '/v1/images/generations'); assert.equal(received[1].url, '/v1/images/edits');
  assert.equal(JSON.parse(received[0].body).model, 'gpt-image-2.6-flare');
  assert.equal(received[0].auth, 'Bearer fixture-only'); assert.match(received[1].type, /multipart\/form-data/);
  assert.ok(received[1].body.includes(PNG));
});
