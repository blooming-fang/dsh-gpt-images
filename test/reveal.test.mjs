import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { createRevealHandler, revealInFileManager, REVEAL_PATH } from '../src/reveal.js';

const TOKEN = 'a'.repeat(64);
const ORIGIN = 'http://127.0.0.1:54321';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const name = (ext = 'png', id = 'a') => 'generated-' + id.repeat(32) + '.' + ext;

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-reveal-'));
  const cacheDir = join(root, 'cache');
  const primaryDir = join(root, 'primary images & 测试');
  await mkdir(cacheDir); await mkdir(primaryDir);
  const filename = name();
  const cache = join(cacheDir, filename);
  const primary = join(primaryDir, filename);
  await writeFile(cache, PNG); await writeFile(primary, PNG);
  t.after(() => rm(root, { recursive: true, force: true }));
  const revealed = [];
  const config = { cacheDir, maxImageBytes: 1024, ...options.config };
  const services = { token: TOKEN, origin: () => ORIGIN, revealFile: async (file) => revealed.push(file), ...options.services };
  const handler = createRevealHandler(config, services);
  return { root, cacheDir, primaryDir, filename, cache, primary, revealed, config, services, handler };
}

async function invoke(handler, input = { filename: name() }, options = {}) {
  const bytes = options.bytes ?? Buffer.from(JSON.stringify(input));
  const req = Readable.from(options.chunks ?? [bytes]);
  req.method = options.method ?? 'POST';
  req.url = options.url ?? REVEAL_PATH;
  req.socket = { remoteAddress: options.remoteAddress ?? '127.0.0.1' };
  req.headers = { origin: ORIGIN, 'content-type': 'application/json', 'x-dsh-gpt-images-token': TOKEN, ...options.headers };
  const response = { status: undefined, headers: {}, text: '', body: undefined };
  const res = {
    writeHead(status, headers) { response.status = status; response.headers = headers; },
    end(text) { response.text = text ?? ''; response.body = text === undefined ? undefined : JSON.parse(text); },
  };
  await handler(req, res);
  assert.ok(response.status, 'handler must finish a response');
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.ok(!response.text.includes(TOKEN), 'token must never be exposed');
  return response;
}

test('exports fixed endpoint and rejects weak or malformed configuration tokens', () => {
  assert.equal(REVEAL_PATH, '/dsh-gpt-images/reveal');
  for (const token of [undefined, '', 'short', 'a'.repeat(513), 'a'.repeat(40) + '\n']) {
    assert.throws(() => createRevealHandler({ cacheDir: tmpdir() }, { token }), /令牌无效/);
  }
});

test('verified primary bytes are selected with stable JSON location contract and no leaked paths', async (t) => {
  const f = await fixture(t);
  const result = await invoke(f.handler, { filename: f.filename, path: f.primary });
  assert.equal(result.status, 200);
  assert.deepEqual(f.revealed, [f.primary]);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.location, 'primary');
  assert.equal(result.body.fallback, false);
  assert.equal(result.headers['access-control-allow-origin'], ORIGIN);
  assert.ok(!result.text.includes(f.root));
});

test('missing, changed, relative, UNC, device, wrong-name and URL primary hints fall back to cache', async (t) => {
  const f = await fixture(t);
  const hints = [undefined, '', 'relative/' + f.filename, join(f.root, 'missing', f.filename), join(f.primaryDir, name('png', 'b')), '\\\\server\\share\\' + f.filename, '//server/share/' + f.filename, '\\\\?\\C:\\images\\' + f.filename, 'file://' + f.primary, f.primary + '\0'];
  await writeFile(f.primary, Buffer.concat([PNG, Buffer.from('changed')]));
  hints.push(f.primary);
  for (const hint of hints) {
    const result = await invoke(f.handler, { filename: f.filename, ...(hint === undefined ? {} : { path: hint }) });
    assert.equal(result.status, 200, String(hint));
    assert.equal(result.body.location, 'cache');
    assert.equal(result.body.fallback, true);
    assert.match(result.body.message, /缓存副本/);
    assert.equal(f.revealed.at(-1), f.cache);
    assert.ok(!result.text.includes(f.root));
  }
});

test('a cache path supplied as primary is still reported as cache', async (t) => {
  const f = await fixture(t);
  const result = await invoke(f.handler, { filename: f.filename, path: f.cache });
  assert.equal(result.body.location, 'cache');
});

test('valid primary alone cannot grant authority when cache is absent', async (t) => {
  const f = await fixture(t); await rm(f.cache);
  const result = await invoke(f.handler, { filename: f.filename, path: f.primary });
  assert.equal(result.status, 404);
  assert.equal(f.revealed.length, 0);
  assert.ok(!result.text.includes(f.root));
});

test('cache must be a regular, bounded image with matching actual signature', async (t) => {
  for (const kind of ['directory', 'empty', 'oversize', 'not-image', 'wrong-extension']) {
    const f = await fixture(t);
    let filename = f.filename;
    await rm(f.cache);
    if (kind === 'directory') await mkdir(f.cache);
    if (kind === 'empty') await writeFile(f.cache, Buffer.alloc(0));
    if (kind === 'oversize') await writeFile(f.cache, Buffer.alloc(1025));
    if (kind === 'not-image') await writeFile(f.cache, Buffer.from('secret text, not an image'));
    if (kind === 'wrong-extension') { filename = name('jpg'); await writeFile(join(f.cacheDir, filename), PNG); }
    const result = await invoke(f.handler, { filename, path: f.primary });
    assert.equal(result.status, 404, kind);
    assert.equal(f.revealed.length, 0);
  }
});

test('supported PNG JPEG WEBP and GIF signatures can anchor a reveal', async (t) => {
  const f = await fixture(t);
  for (const [ext, bytes] of [
    ['png', PNG], ['jpg', Buffer.from([255, 216, 255, 0])],
    ['gif', Buffer.from('GIF89a')], ['webp', Buffer.from('RIFF0000WEBP')],
  ]) {
    const filename = name(ext); await writeFile(join(f.cacheDir, filename), bytes);
    assert.equal((await invoke(f.handler, { filename })).status, 200, ext);
  }
});

test('strict filename and JSON shape reject traversal, trailing newlines, URLs and extra arguments', async (t) => {
  const f = await fixture(t);
  for (const input of [
    null, [], {}, { filename: '../' + f.filename }, { filename: f.filename + '\n' },
    { filename: f.filename.toUpperCase() }, { filename: 'https://images.invalid/' + f.filename },
    { filename: name('svg') }, { filename: f.filename, path: 1 },
    { filename: f.filename, command: 'explorer' }, { filename: f.filename, args: [] },
  ]) assert.equal((await invoke(f.handler, input)).status, 400);
  assert.equal(f.revealed.length, 0);
});

test('request parsing rejects malformed UTF8/JSON, wrong media type and both declared/streamed oversized bodies', async (t) => {
  const f = await fixture(t);
  for (const bytes of [Buffer.from('{'), Buffer.from([0xff]), Buffer.from('')]) {
    assert.equal((await invoke(f.handler, undefined, { bytes })).status, 400);
  }
  assert.equal((await invoke(f.handler, undefined, { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await invoke(f.handler, undefined, { headers: { 'content-length': '4097' } })).status, 413);
  assert.equal((await invoke(f.handler, undefined, { chunks: [Buffer.alloc(3000, 'a'), Buffer.alloc(2000, 'b')] })).status, 413);
  const exact = Buffer.from(JSON.stringify({ filename: f.filename }).padEnd(4096, ' '));
  assert.equal((await invoke(f.handler, undefined, { bytes: exact, headers: { 'content-length': '4096' } })).status, 200);
});

test('socket must be loopback; forwarded headers cannot authorize a remote peer', async (t) => {
  const f = await fixture(t);
  for (const remoteAddress of ['192.168.1.1', '8.8.8.8', '::ffff:192.168.1.1', '2001:db8::1', '', 'localhost']) {
    const result = await invoke(f.handler, undefined, { remoteAddress, headers: { 'x-forwarded-for': '127.0.0.1', forwarded: 'for=127.0.0.1' } });
    assert.equal(result.status, 403, remoteAddress);
    assert.equal(result.headers['access-control-allow-origin'], undefined);
  }
  for (const remoteAddress of ['127.0.0.1', '127.12.1.1', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1']) {
    assert.equal((await invoke(f.handler, undefined, { remoteAddress })).status, 200, remoteAddress);
  }
});

test('HTTP Origin must exactly match the current local origin and may not be missing or null', async (t) => {
  const f = await fixture(t);
  for (const origin of [undefined, 'null', 'https://evil.invalid', 'http://127.0.0.1:1', 'http://localhost:54321', ORIGIN + '/', ORIGIN + '/path', ORIGIN + '?x=1', ORIGIN + '#hash', ORIGIN + ', https://evil.invalid']) {
    assert.equal((await invoke(f.handler, undefined, { headers: { origin } })).status, 403, String(origin));
  }
  const remoteOriginHandler = createRevealHandler(f.config, { ...f.services, origin: () => 'https://remote.invalid' });
  assert.equal((await invoke(remoteOriginHandler, undefined, { headers: { origin: 'https://remote.invalid' } })).status, 403);
});

test('Electron custom standard origins are serialized explicitly, never accepted as literal null', async (t) => {
  const f = await fixture(t);
  for (const origin of ['dsh-app://app', 'dsh-app://desktop', 'dsh-app://desktop/']) {
    const result = await invoke(f.handler, undefined, { headers: { origin } });
    assert.equal(result.status, 200, origin);
    assert.equal(result.headers['access-control-allow-origin'], origin);
  }
  for (const origin of ['dsh-app:', 'dsh-app://', 'dsh-app:///path', 'dsh-app://user:secret@app', 'dsh-app://app/path', 'dsh-app://app?x=1', 'dsh-app://app#x', 'dsh-app:////app', 'null']) {
    assert.equal((await invoke(f.handler, undefined, { headers: { origin } })).status, 403, origin);
  }
});

test('POST requires the secret token even for Electron and preflight does not expose it', async (t) => {
  const f = await fixture(t);
  for (const token of [undefined, '', 'wrong', 'b'.repeat(64), [TOKEN]]) {
    assert.equal((await invoke(f.handler, undefined, { headers: { origin: 'dsh-app://app', 'x-dsh-gpt-images-token': token } })).status, 403);
  }
  assert.equal(f.revealed.length, 0);
  const result = await invoke(f.handler, undefined, {
    method: 'OPTIONS', headers: { origin: 'dsh-app://app', 'x-dsh-gpt-images-token': undefined, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type, x-dsh-gpt-images-token' },
  });
  assert.equal(result.status, 204);
  assert.equal(result.text, '');
  assert.equal(result.headers['access-control-allow-origin'], 'dsh-app://app');
  assert.equal(result.headers['access-control-allow-credentials'], undefined);
  assert.equal(f.revealed.length, 0);
});

test('preflight rejects remote peers, foreign origins, wrong methods and extra headers', async (t) => {
  const f = await fixture(t);
  const preflight = { method: 'OPTIONS', headers: { 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type, x-dsh-gpt-images-token' } };
  for (const options of [
    { ...preflight, remoteAddress: '192.168.1.1' },
    { ...preflight, headers: { ...preflight.headers, origin: 'https://evil.invalid' } },
    { ...preflight, headers: { ...preflight.headers, 'access-control-request-method': 'DELETE' } },
    { ...preflight, headers: { ...preflight.headers, 'access-control-request-headers': 'authorization' } },
  ]) assert.equal((await invoke(f.handler, undefined, options)).status, 403);
  assert.equal(f.revealed.length, 0);
});

test('wrong route or method never invokes native reveal', async (t) => {
  const f = await fixture(t);
  assert.equal((await invoke(f.handler, undefined, { url: '/different' })).status, 404);
  assert.equal((await invoke(f.handler, undefined, { method: 'GET' })).status, 405);
  assert.equal(f.revealed.length, 0);
});

test('symlink/junction primary ancestors fall back to cache without traversal', async (t) => {
  const f = await fixture(t);
  const linked = join(f.root, 'linked-primary');
  await symlink(f.primaryDir, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const result = await invoke(f.handler, { filename: f.filename, path: join(linked, f.filename) });
  assert.equal(result.body.location, 'cache');
  assert.deepEqual(f.revealed, [f.cache]);
});

test('symlink/junction cache root or ancestor cannot be used as trust anchor', async (t) => {
  const f = await fixture(t);
  const linked = join(f.root, 'linked-cache');
  await symlink(f.cacheDir, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const handler = createRevealHandler({ ...f.config, cacheDir: linked }, f.services);
  assert.equal((await invoke(handler, { filename: f.filename, path: f.primary })).status, 404);
  assert.equal(f.revealed.length, 0);
});

test('symlink image leaf is rejected, where filesystem permissions permit creating one', async (t) => {
  const f = await fixture(t); await rm(f.cache);
  try { await symlink(f.primary, f.cache, 'file'); }
  catch (error) { if (error.code === 'EPERM' || error.code === 'EACCES') return t.skip('Host does not permit file symlinks'); throw error; }
  assert.equal((await invoke(f.handler, { filename: f.filename, path: f.primary })).status, 404);
  assert.equal(f.revealed.length, 0);
});

test('native launch errors return a bounded generic response without paths or exception details', async (t) => {
  const f = await fixture(t, { services: { revealFile: async () => { throw new Error('secret C:/private/path'); } } });
  const result = await invoke(f.handler, { filename: f.filename, path: f.primary });
  assert.equal(result.status, 500);
  assert.equal(result.body.ok, false);
  assert.ok(!result.text.includes('secret'));
  assert.ok(!result.text.includes(f.root));
});

test('native helpers use fixed executables, static encoded Windows code and shell:false', async () => {
  const calls = [];
  let unrefCount = 0;
  const spawnProcess = (...args) => {
    calls.push(args); const child = new EventEmitter(); child.unref = () => unrefCount++;
    queueMicrotask(() => { child.emit('spawn'); child.emit('exit', 0); }); return child;
  };
  const windows = 'C:/Users/测试 & name/' + name();
  assert.deepEqual(await revealInFileManager(windows, { platform: 'win32', spawnProcess }), { requested: true, selected: true, foreground: true });
  assert.deepEqual(await revealInFileManager('/tmp/images & names/' + name(), { platform: 'darwin', spawnProcess }), { requested: true, selected: false, foreground: false });
  assert.deepEqual(await revealInFileManager('/tmp/images & names/' + name(), { platform: 'linux', spawnProcess }), { requested: true, selected: false, foreground: false });
  assert.equal(calls[0][0], win32.join(process.env.SystemRoot || process.env.WINDIR || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'));
  assert.deepEqual(calls[0][1].slice(0, 5), ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand']);
  const script = Buffer.from(calls[0][1][5], 'base64').toString('utf16le');
  assert.equal(script, await fs.readFile(new URL('../src/windows-reveal.ps1', import.meta.url), 'utf8'));
  assert.match(script, /SHOpenFolderAndSelectItems/);
  assert.ok(!script.includes(windows));
  assert.ok(!script.includes(win32.normalize(windows)));
  assert.ok(!calls[0][1].includes('-ExecutionPolicy'));
  assert.equal(calls[0][2].env.DSH_GPT_IMAGES_REVEAL_PATH, win32.normalize(windows));
  assert.equal(calls[0][2].windowsHide, true);
  assert.equal(calls[0][2].timeout, 12000);
  assert.equal(calls[0][2].windowsVerbatimArguments, undefined);
  assert.deepEqual(calls.slice(1).map(([exe, args]) => [exe, args]), [
    ['/usr/bin/open', ['-R', '/tmp/images & names/' + name()]],
    ['/usr/bin/xdg-open', ['/tmp/images & names']],
  ]);
  for (const [, , options] of calls) { assert.equal(options.shell, false); assert.equal(options.stdio, 'ignore'); }
  assert.equal(calls[1][2].env, undefined);
  assert.equal(calls[2][2].env, undefined);
  assert.equal(unrefCount, 2);
});


test('native helper rejects unsafe paths or unsupported platforms before spawning, and sanitizes spawn errors', async () => {
  let count = 0;
  const spawnProcess = () => { count++; throw new Error('secret path or arguments'); };
  for (const file of ['relative.png', '\\\\server\\share\\image.png', '//server/share/image.png', '\\\\?\\C:\\image.png', 'C:image.png', 'C:\\image.png\n', 'C:\\image.png:stream']) {
    await assert.rejects(revealInFileManager(file, { platform: 'win32', spawnProcess }), /不被允许/);
  }
  await assert.rejects(revealInFileManager('/tmp/image.png', { platform: 'unknown', spawnProcess }), /不支持/);
  assert.equal(count, 0);
  await assert.rejects(revealInFileManager('C:\\image.png', { platform: 'win32', spawnProcess }), (error) => !error.message.includes('secret'));
  const emitsError = () => { const child = new EventEmitter(); queueMicrotask(() => child.emit('error', new Error('secret'))); return child; };
  await assert.rejects(revealInFileManager('C:\\image.png', { platform: 'win32', spawnProcess: emitsError }), /无法打开/);
});

test('untrusted Windows system roots or quoted paths cannot redirect native argument lookup', async () => {
  const oldRoot = process.env.SystemRoot;
  const oldWindir = process.env.WINDIR;
  let spawned = 0;
  try {
    for (const root of ['relative', '//server/share', '//?/C:/Windows', 'C:Windows', 'C:/with"quote']) {
      process.env.SystemRoot = root;
      await assert.rejects(revealInFileManager('C:/images/image.png', { platform: 'win32', spawnProcess: () => { spawned++; } }), /不被允许/);
    }
    process.env.SystemRoot = 'C:/Windows';
    await assert.rejects(revealInFileManager('C:/images/with"quote.png', { platform: 'win32', spawnProcess: () => { spawned++; } }), /不被允许/);
    assert.equal(spawned, 0);
    delete process.env.SystemRoot; delete process.env.WINDIR;
    const spawnProcess = (executable) => { assert.equal(executable, win32.join('C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')); const child = new EventEmitter(); queueMicrotask(() => child.emit('exit', 0)); return child; };
    await revealInFileManager('C:/images/image.png', { platform: 'win32', spawnProcess });
  } finally {
    if (oldRoot === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = oldRoot;
    if (oldWindir === undefined) delete process.env.WINDIR; else process.env.WINDIR = oldWindir;
  }
});

test('a primary modified during final revalidation falls back to unchanged cache', async (t) => {
  const f = await fixture(t);
  const originalOpen = fs.open;
  let primaryOpens = 0;
  const spy = t.mock.method(fs, 'open', async (file, ...args) => {
    if (file === f.primary && ++primaryOpens === 2) await writeFile(f.primary, Buffer.concat([PNG, Buffer.from('changed during validation')]));
    return originalOpen(file, ...args);
  });
  syncBuiltinESMExports();
  try {
    const result = await invoke(f.handler, { filename: f.filename, path: f.primary });
    assert.equal(result.status, 200);
    assert.equal(result.body.location, 'cache');
    assert.deepEqual(f.revealed, [f.cache]);
  } finally { spy.mock.restore(); syncBuiltinESMExports(); }
});


test('aborted request followed by stream error is handled without unhandled exceptions', async (t) => {
  const f = await fixture(t);
  const req = new Readable({ read() { queueMicrotask(() => { this.emit('aborted'); queueMicrotask(() => this.emit('error', new Error('connection reset'))); }); } });
  req.method = 'POST'; req.url = REVEAL_PATH; req.socket = { remoteAddress: '127.0.0.1' };
  req.headers = { origin: ORIGIN, 'content-type': 'application/json', 'x-dsh-gpt-images-token': TOKEN };
  let status;
  await f.handler(req, { writeHead(code) { status = code; }, end() {} });
  await Promise.resolve();
  assert.equal(status, 400);
  assert.equal(f.revealed.length, 0);
});


test('Windows awaits verified helper exit, reports foreground denial distinctly and rejects failures/timeouts', async () => {
  const child = new EventEmitter();
  let settled = false;
  const pending = revealInFileManager('C:/images/' + name(), { platform: 'win32', spawnProcess: () => child }).then((result) => { settled = true; return result; });
  child.emit('spawn'); await Promise.resolve();
  assert.equal(settled, false);
  child.emit('exit', 0);
  assert.deepEqual(await pending, { requested: true, selected: true, foreground: true });
  assert.equal(settled, true);
  const denied = () => { const process = new EventEmitter(); queueMicrotask(() => process.emit('exit', 10)); return process; };
  assert.deepEqual(await revealInFileManager('C:/images/' + name(), { platform: 'win32', spawnProcess: denied }), { requested: true, selected: true, foreground: false });
  for (const [code, signal] of [[1, null], [5, null], [null, 'SIGTERM'], [0, 'SIGTERM'], [10, 'SIGTERM']]) {
    const spawnProcess = () => { const failed = new EventEmitter(); queueMicrotask(() => { failed.emit('spawn'); failed.emit('exit', code, signal); }); return failed; };
    await assert.rejects(revealInFileManager('C:/images/' + name(), { platform: 'win32', spawnProcess }), /无法确认/);
  }
});

test('static transaction preserves verified UI state and permits only one non-focused selection/activation', async () => {
  const script = await fs.readFile(new URL('../src/windows-reveal.ps1', import.meta.url), 'utf8');
  const flat = script.replace(/\s+/g, '');
  for (const required of ['Shell.Application', '$windows.Item($index)', '$self.Path', 'OrdinalIgnoreCase.Equals', '$sel.Count -ne 1', '$item.Path', 'SelectItem($item, 13)', 'IsWindowVisible', '!IsIconic', 'GetForegroundWindow', 'MonitorFromWindow', 'OnScreen', 'MoveIfOffScreen', 'SetWindowPos', '0x0015', 'AttachThreadInput(current, foreground, false)', 'AttachThreadInput(current, target, false)', '$W.ElapsedMilliseconds -ge 6500', '$W.ElapsedMilliseconds -lt 6500', 'return 10', 'exit $exitCode']) {
    assert.ok(flat.includes(required.replace(/\s+/g, '')), required);
  }
  assert.equal(script.split('SetForegroundWindow(window);').length - 1, 1);
  assert.equal(script.split('ShowWindowAsync(window,9)').length - 1, 1);
  assert.equal(script.split('::RestoreAndActivate($chosen)').length - 1, 1);
  assert.equal(script.split('.SelectItem($item, 13)').length - 1, 1);
  const observe = script.slice(script.indexOf('function Find-Entry('), script.indexOf('function Select-Once('));
  assert.doesNotMatch(observe, /SelectItem|::RestoreAndActivate|::Show\(|OpenDirectoryFallback/);
  assert.ok(flat.includes('$Chosen-ne[IntPtr]::Zero-and$handle-ne$Chosen'));
  assert.ok(flat.indexOf('$Attempted.Value=$true') < flat.indexOf('.SelectItem($item,13)'));
  assert.ok(flat.indexOf('$didActivate=$true') < flat.indexOf('::RestoreAndActivate($chosen)'));
  assert.ok(flat.includes('if(-not($opened-or$didSelect-or$didActivate)){return0}'));
  assert.ok(flat.includes('$W.ElapsedMilliseconds-ge$verifyAt-and$W.ElapsedMilliseconds-ge$settle-and$W.ElapsedMilliseconds-$stable-ge200'));
  assert.ok(flat.includes('-not$sel-and-not$didSelect-and-not$didActivate'));
  const good = script.slice(script.indexOf('if($sel -and $vis -and $fg)'), script.indexOf('} else {\n$stable=-1L'));
  assert.ok(good.length > 0);
  assert.doesNotMatch(good, /Select-Once|::RestoreAndActivate|::Show\(/);
  assert.doesNotMatch(script, /BringWindowToTop|FlashWindowEx|FlashIfBackground|SelectItem\(\$item,\s*29\)|SendKeys|SendInput|keybd_event|HWND_TOPMOST|Write-Host|Write-Output|Write-Error|Start-Process|ExecutionPolicy/);
});

test('static fallback is one-shot only without a seen target and command stays within Windows limit', async () => {
  const script = await fs.readFile(new URL('../src/windows-reveal.ps1', import.meta.url), 'utf8');
  const flat = script.replace(/\s+/g, '');
  for (const required of ['$seen=$false', '$seen=$true', '$didFallback=$false', '-not$seen-and$opened-and-not$didFallback', '$W.ElapsedMilliseconds-$openAt-ge2500', '$didFallback=$true', 'OpenDirectoryFallback([IO.Path]::GetDirectoryName($File))', 'ProcessStartInfo', 'start.UseShellExecute=false', 'Path.Combine(Path.GetFullPath(root),"explorer.exe")', 'LocalAbsolute(root)', 'LocalAbsolute(dir)']) assert.ok(flat.includes(required), required);
  const transaction = script.slice(script.indexOf('function Invoke-Transaction('));
  assert.ok(transaction.indexOf('Find-Entry') < transaction.indexOf('::Show($File)'));
  assert.ok(flat.indexOf('$didFallback=$true') < flat.indexOf('::OpenDirectoryFallback('));
  assert.equal(script.split('::OpenDirectoryFallback(').length - 1, 1);
  assert.ok(Buffer.from(script, 'utf16le').toString('base64').length <= 30000);
});

test('mock PowerShell transaction counts UI requests without calling COM, native APIs or Explorer', { skip: process.platform !== 'win32' }, () => {
  // Execute only PS function definitions from the AST against plain objects and a
  // fake C# class. The production C# P/Invoke and top-level body are NEVER run.
  const harness = String.raw`$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$t=$null; $e=$null
$a=[System.Management.Automation.Language.Parser]::ParseFile($env:DSH_MOCK_REVEAL_SCRIPT,[ref]$t,[ref]$e)
if($e.Count){throw 'Production PS parse failed'}
Add-Type -TypeDefinition @'
using System;
public static class DshImageRevealNative {
public static bool Exists,Selected,Visible,Foreground;
public static int Opens,Selects,Activates,Fallbacks,Flags;
public static long FrontHandle,LastHandle;
public static string Mode;
public static IntPtr RootWindow(IntPtr h){return Exists?h:IntPtr.Zero;}
public static bool VisibleReady(IntPtr h){return Exists&&Visible;}
public static bool IsForeground(IntPtr h){return Exists&&(Mode=="multi"?h.ToInt64()==FrontHandle:Foreground);}
public static void Show(string file){Opens++;if(Mode=="absent"||Mode=="fallback")return;Exists=true;Visible=true;Foreground=true;Selected=Mode!="delayed";}
public static void RestoreAndActivate(IntPtr h){Activates++;LastHandle=h.ToInt64();if(Mode!="deny"){Visible=true;Foreground=true;FrontHandle=h.ToInt64();}}
public static void OpenDirectoryFallback(string dir){Fallbacks++;if(Mode=="fallback"){Exists=true;Visible=true;}}
}
'@
foreach($f in $a.FindAll({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst]},$true)){
. ([scriptblock]::Create($f.Extent.Text))
}
$global:MockItem=[pscustomobject]@{Path=('C:\fixture\generated-'+('a'*32)+'.png')}
$global:MockSelected=[pscustomobject]@{}
$global:MockSelected | Add-Member ScriptProperty Count {if([DshImageRevealNative]::Selected){1}else{0}}
$global:MockSelected | Add-Member ScriptMethod Item {param($i) $global:MockItem}
$folder=[pscustomobject]@{Self=[pscustomobject]@{Path='C:\fixture'}}
$folder | Add-Member ScriptMethod ParseName {param($n) $global:MockItem}
$doc=[pscustomobject]@{Folder=$folder}
$doc | Add-Member ScriptMethod SelectedItems {$global:MockSelected}
$doc | Add-Member ScriptMethod SelectItem {param($item,$flags)
[DshImageRevealNative]::Selects=[DshImageRevealNative]::Selects+1
[DshImageRevealNative]::Flags=$flags
if([DshImageRevealNative]::Mode -ne 'selection-fails'){[DshImageRevealNative]::Selected=$true}
}
$global:MockWindow=[pscustomobject]@{FullName='C:\Windows\explorer.exe';HWND=101;Document=$doc;Visible=$true}
$global:MockWindow2=[pscustomobject]@{FullName='C:\Windows\explorer.exe';HWND=202;Document=$doc;Visible=$true}
$global:MockWindows=[pscustomobject]@{}
$global:MockWindows | Add-Member ScriptProperty Count {if([DshImageRevealNative]::Exists){if([DshImageRevealNative]::Mode -eq 'multi'){2}else{1}}else{0}}
$global:MockWindows | Add-Member ScriptMethod Item {param($i) if($i -eq 1){$global:MockWindow2}else{$global:MockWindow}}
$shell=[pscustomobject]@{}
$shell | Add-Member ScriptMethod Windows {$global:MockWindows}
function Start-Sleep([int]$Milliseconds){
$global:MockWatch.ElapsedMilliseconds+=$Milliseconds
if([DshImageRevealNative]::Mode -eq 'delayed' -and $global:MockWatch.ElapsedMilliseconds -ge 400){[DshImageRevealNative]::Selected=$true}
if([DshImageRevealNative]::Mode -eq 'multi' -and $global:MockWatch.ElapsedMilliseconds -eq 100){[DshImageRevealNative]::FrontHandle=202}
if([DshImageRevealNative]::Mode -eq 'restore-transient'){
if($global:MockWatch.ElapsedMilliseconds -eq 200){[DshImageRevealNative]::Selected=$false}
if($global:MockWatch.ElapsedMilliseconds -ge 400){[DshImageRevealNative]::Selected=$true}
}
}
$results=@()
foreach($mode in 'new','delayed','front','different','minimized','deny','selection-fails','absent','fallback','multi','restore-transient'){
[DshImageRevealNative]::Mode=$mode
[DshImageRevealNative]::Exists=$mode -notin @('new','delayed','absent','fallback')
[DshImageRevealNative]::Selected=$mode -in @('front','minimized','deny','restore-transient')
[DshImageRevealNative]::Visible=$mode -notin @('minimized','restore-transient')
[DshImageRevealNative]::Foreground=$mode -in @('front','different','selection-fails')
[DshImageRevealNative]::Opens=0; [DshImageRevealNative]::Selects=0
[DshImageRevealNative]::Activates=0; [DshImageRevealNative]::Fallbacks=0; [DshImageRevealNative]::Flags=0
[DshImageRevealNative]::FrontHandle=0; [DshImageRevealNative]::LastHandle=0
$global:MockWatch=[pscustomobject]@{ElapsedMilliseconds=0}
$code=Invoke-Transaction $shell $global:MockItem.Path $global:MockWatch
$results += [pscustomobject]@{mode=$mode;code=$code;open=[DshImageRevealNative]::Opens;select=[DshImageRevealNative]::Selects;activate=[DshImageRevealNative]::Activates;fallback=[DshImageRevealNative]::Fallbacks;flags=[DshImageRevealNative]::Flags;handle=[DshImageRevealNative]::LastHandle;elapsed=$global:MockWatch.ElapsedMilliseconds}
}
ConvertTo-Json -InputObject $results -Compress
`;
  const executable = win32.join(process.env.SystemRoot || process.env.WINDIR || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const result = spawnSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(harness, 'utf16le').toString('base64')], {
    shell: false, windowsHide: true, encoding: 'utf8', timeout: 20000,
    env: { ...process.env, DSH_MOCK_REVEAL_SCRIPT: fileURLToPath(new URL('../src/windows-reveal.ps1', import.meta.url)) },
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const rows = JSON.parse(result.stdout.trim());
  const expected = {
    new: [0, 1, 0, 0, 0], delayed: [0, 1, 0, 0, 0], front: [0, 0, 0, 0, 0],
    different: [0, 0, 1, 0, 0], minimized: [0, 0, 0, 1, 0], deny: [10, 0, 0, 1, 0],
    'selection-fails': [1, 0, 1, 0, 0], absent: [1, 1, 0, 0, 1], fallback: [0, 1, 1, 1, 1], multi: [0, 0, 1, 1, 0], 'restore-transient': [0, 0, 0, 1, 0],
  };
  for (const row of rows) {
    assert.deepEqual([row.code, row.open, row.select, row.activate, row.fallback], expected[row.mode], row.mode);
    if (row.select) assert.equal(row.flags, 13);
    if (row.mode === 'multi') assert.equal(row.handle, 101, 'must not switch to a second HWND that became foreground mid-transaction');
    if (row.mode === 'restore-transient') assert.ok(row.elapsed >= 600, 'must wait through transient loss and 200ms stable selection');
    if (row.mode === 'front') assert.equal(row.elapsed, 0, 'zero-action foreground image should return immediately');
    if (row.mode === 'new' || row.mode === 'delayed') assert.ok(row.elapsed >= 650, 'good waiting must honor native settle without additional activation');
    assert.ok(row.elapsed <= 6500, row.mode);
  }
  assert.equal(rows.length, 11);
});
