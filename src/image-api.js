import { extractImages, sniffImage } from './extract.js';

export const IMAGE_API_DEFAULTS = Object.freeze({
  imageApiBaseURL: 'http://localhost:8317',
  imageApiKey: '',
  imageApiKeyEnv: 'DSH_IMAGE_API_KEY',
  imageModel: 'gpt-image-2.6-flare',
  imageTimeoutMs: 300000,
  imageToolsEnabled: true,
});

const DEFAULT_RESPONSE_LIMIT = 96 * 1024 * 1024;
const DEFAULT_IMAGE_LIMIT = 20 * 1024 * 1024;
const FORMATS = new Set(['png', 'jpeg', 'webp', 'gif']);
const INPUT_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

class ImageApiError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ImageApiError';
    this.code = code;
  }
}

function fail(code, message) {
  return new ImageApiError(code, message);
}

function positiveInteger(value, fallback, label) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) {
    throw fail('INVALID_CONFIG', label + ' 必须是正整数。');
  }
  return result;
}

function endpoint(base, operation) {
  let url;
  try {
    if (typeof base !== 'string' || !base.trim()) throw new Error();
    url = new URL(base);
  } catch {
    throw fail('INVALID_BASE_URL', 'imageApiBaseURL 必须是有效的 HTTP/HTTPS API 地址。');
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
  if (url.username || url.password || base.includes('?') || base.includes('#') ||
      !(url.protocol === 'https:' || (url.protocol === 'http:' && loopback))) {
    throw fail('INVALID_BASE_URL', 'imageApiBaseURL 不允许凭据、查询或片段；仅本机 loopback 可使用 HTTP，远程地址必须使用 HTTPS。');
  }
  // A non-root path is already the configured API mount (including custom prefixes).
  const prefix = url.pathname.replace(/\/+$/, '') || '/v1';
  url.pathname = prefix + '/images/' + (operation === 'generate' ? 'generations' : 'edits');
  return url.href;
}

function fieldsFor(args, config, limit) {
  if (!args || typeof args !== 'object' || typeof args.prompt !== 'string' || !args.prompt.trim()) {
    throw fail('INVALID_ARGUMENT', 'prompt 必须是非空字符串。');
  }
  const model = args.model ?? config.imageModel;
  if (typeof model !== 'string' || !model.trim()) throw fail('INVALID_ARGUMENT', 'model 必须是非空字符串。');
  const n = args.n ?? 1;
  if (!Number.isInteger(n) || n < 1 || n > limit) {
    throw fail('INVALID_ARGUMENT', 'n 必须是 1 到 ' + limit + ' 的整数。');
  }
  const fields = { prompt: args.prompt, model, n };
  for (const name of ['size', 'quality', 'background', 'output_format']) {
    if (args[name] === undefined || (name === 'size' && args.output_format === 'gif')) continue;
    if (typeof args[name] !== 'string' || !args[name].trim()) {
      throw fail('INVALID_ARGUMENT', name + ' 必须是非空字符串。');
    }
    fields[name] = args[name];
  }
  if (fields.output_format !== undefined && !FORMATS.has(fields.output_format)) {
    throw fail('INVALID_ARGUMENT', 'output_format 仅支持 png、jpeg、webp、gif；不支持 SVG。');
  }
  for (const [name, fallback] of [['frame_count', 9], ['frame_duration_ms', 200]]) {
    const value = args[name] === undefined && fields.output_format === 'gif' ? fallback : args[name];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 1) {
      throw fail('INVALID_ARGUMENT', name + ' 必须是正的安全整数。');
    }
    if (fields.output_format !== 'gif') {
      throw fail('INVALID_ARGUMENT', name + ' 仅用于 GIF，请同时设置 output_format 为 gif。');
    }
    fields[name] = value;
  }
  // Deliberately whitelist fields: tool arguments cannot supply a URL, key, or headers.
  return fields;
}

/** Validate tool arguments before the caller authorizes or reads any edit files. */
export function validateImageArgs(operation, args, config = {}) {
  const settings = { ...IMAGE_API_DEFAULTS, ...config };
  if (settings.imageToolsEnabled === false) throw fail('TOOLS_DISABLED', 'Image API 工具已禁用。');
  if (operation !== 'generate' && operation !== 'edit') throw fail('INVALID_OPERATION', 'Image API 操作仅支持 generate 或 edit。');
  return fieldsFor(args, settings, Math.min(positiveInteger(settings.maxImages, 20, 'maxImages'), 10));
}

function imageBlob(item, maxBytes) {
  if (!item || !(item.bytes instanceof Uint8Array || item.bytes instanceof ArrayBuffer)) {
    throw fail('INVALID_IMAGE', '编辑图片必须提供已授权读取的图片字节。');
  }
  const bytes = item.bytes instanceof Uint8Array
    ? Buffer.from(item.bytes.buffer, item.bytes.byteOffset, item.bytes.byteLength)
    : Buffer.from(item.bytes);
  if (!bytes.length || bytes.length > maxBytes) throw fail('INVALID_IMAGE', '编辑图片为空或超过大小限制。');
  let mediaType;
  try {
    mediaType = sniffImage(bytes).mediaType;
  } catch {
    throw fail('INVALID_IMAGE', '编辑图片仅支持 PNG / JPEG / WebP / GIF，不支持 SVG。');
  }
  if (item.mediaType !== undefined && (!INPUT_TYPES.has(item.mediaType) || item.mediaType !== mediaType)) {
    throw fail('INVALID_IMAGE', '编辑图片媒体类型与实际格式不匹配；不支持 SVG。');
  }
  const filename = typeof item.filename === 'string'
    ? item.filename.split(/[\\/]/).pop().replace(/[\r\n\x00]/g, '')
    : '';
  return { blob: new Blob([bytes], { type: mediaType }), filename: filename || 'image.' + (mediaType === 'image/jpeg' ? 'jpg' : mediaType.slice(6)) };
}

function cancelBody(body) {
  try { Promise.resolve(body?.cancel()).catch(() => {}); } catch { /* best effort; never leak upstream errors */ }
}

function abortable(promise, signal) {
  if (signal.aborted) {
    Promise.resolve(promise).catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => { cleanup(); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); },
    );
  });
}

async function responseJSON(response, maxBytes, signal) {
  if (Number(response.headers.get('content-length')) > maxBytes) {
    cancelBody(response.body);
    throw fail('RESPONSE_TOO_LARGE', 'Image API 响应超过 maxResponseBytes 限制。');
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    throw fail('INVALID_RESPONSE', 'Image API 未返回有效的 JSON 响应。');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  let complete = false;
  try {
    while (true) {
      const { value, done } = await abortable(reader.read(), signal);
      signal.throwIfAborted();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw fail('RESPONSE_TOO_LARGE', 'Image API 响应超过 maxResponseBytes 限制。');
      chunks.push(Buffer.from(value));
    }
    complete = true;
  } finally {
    if (!complete) cancelBody(reader);
    try { reader.releaseLock(); } catch { /* a cancelled read may still be settling */ }
  }
  try {
    return JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
  } catch {
    throw fail('INVALID_RESPONSE', 'Image API 未返回有效的 JSON 响应。');
  }
}

/**
 * Independent Images API client. No provider configuration, file reads, image downloads,
 * persistence, retries, or host profile changes. The caller authorizes and reads edit files.
 * Returns extraction candidates for the existing validated storage pipeline.
 */
export async function requestImages(operation, args, config = {}, { signal, fetch = globalThis.fetch, images = [], mask } = {}) {
  const settings = { ...IMAGE_API_DEFAULTS, ...config };
  if (settings.imageToolsEnabled === false) throw fail('TOOLS_DISABLED', 'Image API 工具已禁用。');
  if (operation !== 'generate' && operation !== 'edit') throw fail('INVALID_OPERATION', 'Image API 操作仅支持 generate 或 edit。');
  signal?.throwIfAborted();
  const maxImages = positiveInteger(settings.maxImages, 20, 'maxImages');
  const outputLimit = Math.min(maxImages, 10);
  const maxBytes = positiveInteger(settings.maxResponseBytes, DEFAULT_RESPONSE_LIMIT, 'maxResponseBytes');
  const timeoutMs = positiveInteger(settings.imageTimeoutMs, IMAGE_API_DEFAULTS.imageTimeoutMs, 'imageTimeoutMs');
  if (timeoutMs > 2147483647) throw fail('INVALID_CONFIG', 'imageTimeoutMs 超过支持的计时范围。');
  const url = endpoint(settings.imageApiBaseURL, operation);
  const fields = validateImageArgs(operation, args, settings);
  const headers = { Accept: 'application/json' };
  const configuredKey = settings.imageApiKey;
  const envName = settings.imageApiKeyEnv;
  if (typeof configuredKey !== 'string' || typeof envName !== 'string') throw fail('INVALID_CONFIG', 'imageApiKey 与 imageApiKeyEnv 必须是字符串。');
  const key = configuredKey.trim() || (envName ? process.env[envName]?.trim() : '') || '';
  if (/[\r\n\x00]/.test(key)) throw fail('INVALID_CONFIG', 'Image API key 配置包含非法字符。');
  if (key) headers.Authorization = 'Bearer ' + key;
  let body;
  if (operation === 'generate') {
    if (images.length || mask !== undefined) throw fail('INVALID_ARGUMENT', 'generate 不接受编辑图片或 mask。');
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(fields);
  } else {
    if (!Array.isArray(images) || !images.length || images.length > maxImages) throw fail('INVALID_IMAGE', 'edit 必须提供有效数量的已授权图片。');
    const maxImageBytes = positiveInteger(settings.maxImageBytes, DEFAULT_IMAGE_LIMIT, 'maxImageBytes');
    body = new FormData();
    for (const [name, value] of Object.entries(fields)) body.append(name, String(value));
    for (const image of images) {
      const { blob, filename } = imageBlob(image, maxImageBytes);
      body.append(images.length === 1 ? 'image' : 'image[]', blob, filename);
    }
    if (mask !== undefined) {
      const { blob, filename } = imageBlob(mask, maxImageBytes);
      body.append('mask', blob, filename);
    }
    // Do not set Content-Type: fetch must add the multipart boundary.
  }
  if (typeof fetch !== 'function') throw fail('INVALID_CONFIG', '当前运行环境不支持 Image API fetch。');
  const controller = new AbortController();
  const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(new DOMException('Image API 请求超时。', 'TimeoutError')), timeoutMs);
  let response;
  try {
    requestSignal.throwIfAborted();
    // Exactly one attempt, and never forward authorization across a redirect.
    const pending = Promise.resolve(fetch(url, { method: 'POST', headers, body, redirect: 'error', signal: requestSignal }));
    // Also close a late response from an injected transport that ignores cancellation.
    pending.then((late) => { if (requestSignal.aborted) cancelBody(late?.body); }, () => {});
    response = await abortable(pending, requestSignal);
    requestSignal.throwIfAborted();
    if (!response.ok) {
      cancelBody(response.body);
      if (response.status === 401) throw fail('UNAUTHORIZED', 'Image API 鉴权失败（HTTP 401）：请配置 imageApiKey 或 imageApiKeyEnv 指定的环境变量。');
      const status = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : 'error';
      throw fail('HTTP_ERROR', 'Image API 请求失败（HTTP ' + status + '），未自动重试。');
    }
    const result = await responseJSON(response, maxBytes, requestSignal);
    requestSignal.throwIfAborted();
    // Never pass the full envelope to extractImages: unrelated Chat/Responses outputs
    // and arbitrary nested fields are not Images API results.
    const data = Array.isArray(result?.data) ? result.data.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const media = { mime_type: item.mime_type, media_type: item.media_type };
      if (typeof item.b64_json === 'string') return [{ b64_json: item.b64_json, ...media }];
      if (typeof item.url === 'string' && /^(https?:\/\/|data:image\/)/i.test(item.url)) return [{ url: item.url }];
      return [];
    }) : [];
    const extracted = extractImages({ data });
    if (!extracted.length) throw fail('NO_IMAGES', 'Image API 响应中没有可用的图片。');
    if (extracted.length > outputLimit) throw fail('TOO_MANY_IMAGES', 'Image API 返回图片数量超过 maxImages 或 API 上限。');
    return { images: extracted, model: fields.model };
  } catch (error) {
    if (requestSignal.aborted) {
      cancelBody(response?.body);
      throw requestSignal.reason;
    }
    if (error instanceof ImageApiError) throw error;
    // Fetch/body exceptions can include URLs, keys, or echoed upstream content.
    throw fail('REQUEST_FAILED', 'Image API 网络请求或响应读取失败；未自动重试。');
  } finally {
    clearTimeout(timer);
  }
}
