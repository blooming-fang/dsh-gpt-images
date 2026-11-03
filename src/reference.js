import { timingSafeEqual } from 'node:crypto';
import { isTrustedImageOrigin, readCachedImage } from './reveal.js';

export const REFERENCE_PATH = '/dsh-gpt-images/reference';
const TOKEN_HEADER = 'x-dsh-gpt-images-token';
const BODY_LIMIT = 4096;
const FILE_NAME = /^generated-[a-f0-9]{32}\.(?:png|jpg|webp|gif)$/;

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
      req.removeListener('error', failed); req.removeListener('aborted', failed); req.removeListener('close', closed);
      if (error) {
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
    const closed = () => { if (!req.readableEnded) failed(); };
    const timer = setTimeout(() => finish(Object.assign(new Error('body timeout'), { status: 408 })), 5000);
    timer.unref();
    req.on('data', data); req.once('end', end); req.once('error', failed); req.once('aborted', failed); req.once('close', closed);
  });
}

function json(res, status, message, headers = {}) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
  res.end(message === undefined ? undefined : JSON.stringify({ ok: false, message }));
}

/** Binary-only success response; this handler never accepts paths or launches native processes. */
export function createReferenceHandler(config, { token, origins = () => [] } = {}) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 512 || /[^\x21-\x7e]/.test(token)) throw new Error('图片引用令牌无效。');
  const expected = Buffer.from(token);
  return async (req, res) => {
    let disconnected = !!req.aborted || !!res.destroyed;
    const gone = () => { disconnected = true; };
    req.once('aborted', gone); res.once?.('close', gone);
    try {
      if (disconnected) return;
      let pathname;
      try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { pathname = ''; }
      if (pathname !== REFERENCE_PATH) return json(res, 404, '图片引用请求无效。');
      let trusted = false;
      try { trusted = isTrustedImageOrigin(req.headers.origin, origins()); } catch { /* Fail closed on unavailable configuration. */ }
      if (!trusted) return json(res, 403, '图片引用来源验证失败。');
      const cors = {
        'access-control-allow-origin': req.headers.origin,
        'access-control-allow-methods': 'POST',
        'access-control-allow-headers': 'content-type, ' + TOKEN_HEADER,
        vary: 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
      };
      if (req.method === 'OPTIONS') {
        const requested = req.headers['access-control-request-headers'];
        const names = typeof requested === 'string' ? requested.toLowerCase().split(',').map((part) => part.trim()) : [];
        if (req.headers['access-control-request-method'] !== 'POST' || names.some((part) => !['content-type', TOKEN_HEADER].includes(part))) return json(res, 403, '图片引用预检无效。');
        return json(res, 204, undefined, cors);
      }
      if (req.method !== 'POST') return json(res, 405, '图片引用需要 POST 请求。', { ...cors, allow: 'POST, OPTIONS' });
      const supplied = req.headers[TOKEN_HEADER];
      if (typeof supplied !== 'string' || Buffer.byteLength(supplied) !== expected.length || !timingSafeEqual(Buffer.from(supplied), expected)) return json(res, 403, '图片引用验证失败。', cors);
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '')) return json(res, 415, '图片引用需要 JSON 请求。', cors);
      const length = req.headers['content-length'];
      if (length !== undefined && (typeof length !== 'string' || !/^\d+$/.test(length) || Number(length) > BODY_LIMIT)) return json(res, 413, '图片引用请求过大。', cors);
      let input;
      try {
        input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBody(req)));
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 ||
          typeof input.filename !== 'string' || input.filename.match(FILE_NAME)?.[0] !== input.filename) throw new Error('invalid input');
      } catch (error) {
        if (disconnected) return;
        return json(res, error.status === 413 ? 413 : error.status === 408 ? 408 : 400, error.status === 413 ? '图片引用请求过大。' : error.status === 408 ? '图片引用请求超时。' : '图片引用请求无效。', cors);
      }
      if (disconnected) return;
      let image;
      try { image = await readCachedImage(config, input.filename); }
      catch { return disconnected ? undefined : json(res, 404, '图片缓存不可用，请重新生成图片。', cors); }
      if (disconnected || res.destroyed || res.writableEnded) return;
      res.writeHead(200, {
        ...cors, 'content-type': image.mediaType, 'content-length': image.bytes.length,
        'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        'referrer-policy': 'no-referrer',
      });
      res.end(image.bytes);
    } finally { req.removeListener('aborted', gone); res.removeListener?.('close', gone); }
  };
}
