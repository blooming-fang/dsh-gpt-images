import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { constants, readFileSync } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { BlockList, isIP } from 'node:net';
import path from 'node:path';
import { sniffImage } from './extract.js';
import { cacheDirectory } from './storage.js';

export const REVEAL_PATH = '/dsh-gpt-images/reveal';
const TOKEN_HEADER = 'x-dsh-gpt-images-token';
const FILE_NAME = /^generated-[a-f0-9]{32}\.(?:png|jpg|webp|gif)$/;
const BODY_LIMIT = 4096;
const MAX_FILE_BYTES = 200 * 1024 * 1024;
const loopback = new BlockList();
loopback.addSubnet('127.0.0.0', 8, 'ipv4');
loopback.addAddress('::1', 'ipv6');

function isLoopback(address) {
  const family = isIP(address || '');
  return !!family && loopback.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

function localAbsolute(value, platform = process.platform) {
  if (typeof value !== 'string' || !value || /[\u0000-\u001f\u007f]/.test(value) || /^[/\\]{2}/.test(value)) return false;
  if (platform === 'win32') return /^[a-z]:[/\\]/i.test(value) && !value.slice(2).includes(':') && !value.includes('"');
  return path.posix.isAbsolute(value);
}

/** Fixed native entry points only; user paths are never executable code. */
export function revealInFileManager(file, { platform = process.platform, spawnProcess = spawn } = {}) {
  if (!localAbsolute(file, platform)) return Promise.reject(new Error('图片位置不被允许。'));
  const windows = platform === 'win32';
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:/Windows';
  if (windows && !localAbsolute(systemRoot, 'win32')) return Promise.reject(new Error('系统文件管理器位置不被允许。'));
  const executable = windows ? path.win32.join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe') : platform === 'darwin' ? '/usr/bin/open' : platform === 'linux' ? '/usr/bin/xdg-open' : undefined;
  if (!executable) return Promise.reject(new Error('当前系统不支持打开图片位置。'));
  return new Promise((resolve, reject) => {
    try {
      // This is a packaged, static P/Invoke helper, not a generated command. The
      // filename is environment data only and never enters its source/arguments.
      const args = windows
        ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(readFileSync(new URL('./windows-reveal.ps1', import.meta.url), 'utf8'), 'utf16le').toString('base64')]
        : platform === 'darwin' ? ['-R', file] : [path.posix.dirname(file)];
      const options = windows
        ? { shell: false, stdio: 'ignore', windowsHide: true, timeout: 12000, env: { ...process.env, DSH_GPT_IMAGES_REVEAL_PATH: path.win32.normalize(file) } }
        : { shell: false, stdio: 'ignore', detached: true };
      const child = spawnProcess(executable, args, options);
      child.once('error', () => reject(new Error('无法打开图片所在位置。')));
      if (windows) child.once('exit', (code, signal) => {
        if (!signal && (code === 0 || code === 10)) resolve({ requested: true, selected: true, foreground: code === 0 });
        else reject(new Error('无法确认图片所在窗口，请手动打开保存位置。'));
      });
      else child.once('spawn', () => { child.unref?.(); resolve({ requested: true, selected: false, foreground: false }); });
    } catch {
      reject(new Error('无法打开图片所在位置。'));
    }
  });
}


function trustedOrigin(value, getOrigin) {
  if (typeof value !== 'string') return false;
  try {
    const supplied = new URL(value);
    if (supplied.protocol === 'dsh-app:') {
      const serialized = supplied.protocol + '//' + supplied.host;
      return !!supplied.host && !supplied.username && !supplied.password && !supplied.search && !supplied.hash &&
        (!supplied.pathname || supplied.pathname === '/') && (value === serialized || value === serialized + '/');
    }
    const expected = new URL(getOrigin());
    const host = expected.hostname.replace(/^\[|\]$/g, '');
    return ['http:', 'https:'].includes(expected.protocol) && !expected.username && !expected.password &&
      (host === 'localhost' || isLoopback(host)) && supplied.origin === expected.origin && value === supplied.origin;
  } catch { return false; }
}

function matchesToken(actual, expected) {
  if (typeof actual !== 'string') return false;
  const bytes = Buffer.from(actual);
  return bytes.length === expected.length && timingSafeEqual(bytes, expected);
}

function response(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    const finish = (error, bytes) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.removeListener('data', data); req.removeListener('end', end);
      req.removeListener('error', failed); req.removeListener('aborted', failed);
      if (error) {
        // An aborted IncomingMessage can emit ECONNRESET after 'aborted'.
        req.once('error', () => {}); req.resume(); reject(error);
      } else resolve(bytes);
    };
    const data = (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) return finish(Object.assign(new Error('body limit'), { status: 413 }));
      chunks.push(chunk);
    };
    const end = () => finish(undefined, Buffer.concat(chunks));
    const failed = () => finish(new Error('body unavailable'));
    const timer = setTimeout(() => finish(new Error('body timeout')), 5000);
    timer.unref();
    req.on('data', data); req.once('end', end); req.once('error', failed); req.once('aborted', failed);
  });
}

// Check ancestors in order BEFORE descending, so a symlink to a network share is never traversed.
async function checkedEntry(file) {
  if (!localAbsolute(file)) throw new Error('unsafe path');
  const normalized = path.resolve(file);
  const root = path.parse(normalized).root;
  let current = root;
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('unsafe root');
  const segments = normalized.slice(root.length).split(path.sep).filter(Boolean);
  for (let i = 0; i < segments.length; i++) {
    current = path.join(current, segments[i]);
    const entry = await lstat(current);
    if (entry.isSymbolicLink() || (i < segments.length - 1 ? !entry.isDirectory() : !entry.isFile())) throw new Error('unsafe entry');
    if (i === segments.length - 1) return { file: normalized, stat: entry };
  }
  throw new Error('not a file');
}

function sameEntry(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

async function safeImage(file, limit, extension) {
  const before = await checkedEntry(file);
  if (before.stat.size < 1 || before.stat.size > limit) throw new Error('invalid size');
  let handle;
  try {
    handle = await open(before.file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = await handle.stat();
    if (!opened.isFile() || !sameEntry(before.stat, opened)) throw new Error('changed entry');
    const bytes = Buffer.alloc(opened.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const { bytesRead } = await handle.read(bytes, count, bytes.length - count, count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    const after = await checkedEntry(before.file);
    if (count !== opened.size || !sameEntry(opened, await handle.stat()) || !sameEntry(opened, after.stat)) throw new Error('changed file');
    const data = bytes.subarray(0, count);
    if (sniffImage(data).ext !== extension) throw new Error('invalid image');
    return { file: before.file, bytes: data };
  } finally { await handle?.close(); }
}

/** Strict browser Origin matching for non-native image APIs, including configured remote roots. */
export function isTrustedImageOrigin(value, allowedOrigins = []) {
  if (typeof value !== 'string') return false;
  try {
    const supplied = new URL(value);
    if (supplied.protocol === 'dsh-app:') {
      const serialized = supplied.protocol + '//' + supplied.host;
      return !!supplied.host && !supplied.username && !supplied.password && !supplied.search && !supplied.hash &&
        (!supplied.pathname || supplied.pathname === '/') && (value === serialized || value === serialized + '/');
    }
    if (!['http:', 'https:'].includes(supplied.protocol) || value !== supplied.origin || !Array.isArray(allowedOrigins)) return false;
    return allowedOrigins.some((candidate) => {
      if (typeof candidate !== 'string') return false;
      try {
        const expected = new URL(candidate);
        return ['http:', 'https:'].includes(expected.protocol) && !expected.username && !expected.password &&
          !expected.search && !expected.hash && expected.origin === value;
      } catch { return false; }
    });
  } catch { return false; }
}

/** Read only a bounded, verified generated image inside the server-owned cache. */
export async function readCachedImage(config, filename) {
  try {
    if (typeof filename !== 'string' || filename.match(FILE_NAME)?.[0] !== filename) throw new Error('invalid name');
    const configuredLimit = config.maxImageBytes;
    const limit = Number.isSafeInteger(configuredLimit) && configuredLimit > 0 ? Math.min(configuredLimit, MAX_FILE_BYTES) : 20 * 1024 * 1024;
    const image = await safeImage(path.join(cacheDirectory(config), filename), limit, filename.split('.').pop());
    return { ...image, mediaType: sniffImage(image.bytes).mediaType };
  } catch { throw new Error('图片缓存不可用。'); }
}

/**
 * Local, token-authenticated POST endpoint. A safe existing cache image is mandatory;
 * the caller's primary path is only a hint and never grants authority on its own.
 * OPTIONS intentionally authenticates peer + Origin but not a token (CORS preflight).
 */
export function createRevealHandler(config, { token, origin = () => '', revealFile = revealInFileManager } = {}) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 512 || /[^\x21-\x7e]/.test(token)) throw new Error('图片定位令牌无效。');
  const expectedToken = Buffer.from(token);
  const directory = cacheDirectory(config);
  const configuredLimit = config.maxImageBytes;
  const limit = Number.isSafeInteger(configuredLimit) && configuredLimit > 0 ? Math.min(configuredLimit, MAX_FILE_BYTES) : 20 * 1024 * 1024;
  return async (req, res) => {
    let pathname;
    try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { pathname = ''; }
    if (pathname !== REVEAL_PATH) return response(res, 404, { ok: false, message: '图片定位请求无效。' });
    const requestOrigin = req.headers.origin;
    if (!isLoopback(req.socket?.remoteAddress) || !trustedOrigin(requestOrigin, origin)) return response(res, 403, { ok: false, message: '仅允许可信的本机页面定位图片。' });
    const cors = { 'access-control-allow-origin': requestOrigin, vary: 'Origin', 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type, ' + TOKEN_HEADER };
    if (req.method === 'OPTIONS') {
      const requested = req.headers['access-control-request-headers'];
      const headers = typeof requested === 'string' ? requested.toLowerCase().split(',').map((part) => part.trim()) : [];
      if (req.headers['access-control-request-method'] !== 'POST' || headers.some((part) => !['content-type', TOKEN_HEADER].includes(part))) return response(res, 403, { ok: false, message: '图片定位预检无效。' });
      return response(res, 204, undefined, cors);
    }
    if (req.method !== 'POST') return response(res, 405, { ok: false, message: '图片定位需要 POST 请求。' }, { ...cors, allow: 'POST, OPTIONS' });
    if (!matchesToken(req.headers[TOKEN_HEADER], expectedToken)) return response(res, 403, { ok: false, message: '图片定位验证失败。' }, cors);
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '')) return response(res, 415, { ok: false, message: '图片定位需要 JSON 请求。' }, cors);
    const length = req.headers['content-length'];
    if (length !== undefined && (typeof length !== 'string' || !/^\d+$/.test(length) || Number(length) > BODY_LIMIT)) return response(res, 413, { ok: false, message: '图片定位请求过大。' }, cors);
    let input;
    try {
      input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBody(req)));
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['filename', 'path'].includes(key)) ||
        typeof input.filename !== 'string' || input.filename.match(FILE_NAME)?.[0] !== input.filename || (input.path !== undefined && typeof input.path !== 'string')) throw new Error('invalid input');
    } catch (error) {
      return response(res, error.status === 413 ? 413 : 400, { ok: false, message: error.status === 413 ? '图片定位请求过大。' : '图片定位请求无效。' }, cors);
    }
    let cached;
    const extension = input.filename.split('.').pop();
    try { cached = await safeImage(path.join(directory, input.filename), limit, extension); }
    catch { return response(res, 404, { ok: false, message: '图片缓存不可用，请重新生成或下载图片。' }, cors); }
    let selected = cached;
    let location = 'cache';
    if (localAbsolute(input.path) && path.basename(input.path) === input.filename) {
      try {
        const primary = await safeImage(input.path, limit, extension);
        if (primary.file !== cached.file && primary.bytes.equals(cached.bytes)) { selected = primary; location = 'primary'; }
      } catch { /* Untrusted or stale primary hints fall back to the verified cache. */ }
    }
    try {
      // Recheck immediately before native launch; no pathname API can exclude a
      // hostile local process racing a rename after this check.
      let current;
      try {
        current = await safeImage(selected.file, limit, extension);
        if (!current.bytes.equals(cached.bytes)) throw new Error('changed image');
      } catch {
        location = 'cache';
        current = await safeImage(cached.file, limit, extension);
        if (!current.bytes.equals(cached.bytes)) throw new Error('changed cache');
      }
      const native = await revealFile(current.file);
      const selectionConfirmed = native?.selected === true;
      const foreground = selectionConfirmed && native?.foreground === true;
      const target = location === 'cache' ? '图片缓存副本' : '图片';
      const message = selectionConfirmed && foreground ? '已打开文件夹并选中' + target + '。'
        : selectionConfirmed ? target + '已选中，但资源管理器仍在后台，请从任务栏切换查看。'
        : '已请求打开' + target + '所在文件夹，但尚未确认窗口显示。';
      return response(res, 200, {
        ok: true, location, fallback: location === 'cache', requested: true, selected: selectionConfirmed, foreground, message,
      }, cors);
    } catch { return response(res, 500, { ok: false, message: '未确认资源管理器已打开并选中图片，请重试或复制保存路径手动打开。' }, cors); }
  };
}
