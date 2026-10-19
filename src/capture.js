import { AsyncLocalStorage } from 'node:async_hooks';
import { extractImages, candidateKey } from './extract.js';

const KEY = Symbol.for('dsh-gpt-images.fetch-bridge.v2');

/** 只观察模型调用类 POST；工具/网页请求不在捕获范围。 */
const ENDPOINT = /\/(?:chat\/completions|responses|images\/(?:generations|edits)|messages)\/?$|:(?:streamGenerateContent|generateContent)$/;

/**
 * 有界的 JSON / SSE 观察器：只旁路读取响应字节，不修改、不重放、不缓存完整响应。
 */
export class WireObserver {
  constructor(contentType, capture) {
    this.sse = contentType.includes('text/event-stream');
    this.capture = capture;
    this.decoder = new TextDecoder();
    this.buffer = '';
    this.total = 0;
    this.disabled = false;
  }

  parse(text) {
    if (!text.trim() || text.trim() === '[DONE]') return;
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      // 未知或损坏的帧不能影响原响应流。
      return;
    }
    for (const item of Array.isArray(value) ? value : [value]) {
      let candidates;
      try {
        candidates = extractImages(item);
      } catch {
        continue;
      }
      for (const candidate of candidates) {
        const key = candidateKey(candidate);
        if (this.capture.keys.has(key)) continue;
        if (this.capture.images.length >= this.capture.maxImages) {
          this.capture.warn('返回的图片超过数量上限，其余图片未处理。');
          return;
        }
        this.capture.keys.add(key);
        this.capture.images.push(candidate);
      }
    }
  }

  feed(bytes) {
    if (this.disabled) return;
    this.total += bytes.byteLength;
    if (this.total > this.capture.maxResponseBytes) {
      this.disabled = true;
      this.buffer = '';
      this.capture.warn('响应超过图片捕获大小限制，后续图片未捕获。');
      return;
    }
    this.buffer += this.decoder.decode(bytes, { stream: true });
    if (!this.sse) return;
    // CRLF 可能跨网络分片：只消费完整的空行分隔符。
    let match;
    while ((match = /\r?\n\r?\n/.exec(this.buffer))) {
      const frame = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      this.frame(frame);
    }
  }

  frame(frame) {
    const lines = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''));
    if (lines.length) this.parse(lines.join('\n'));
  }

  finish() {
    if (this.disabled) return;
    this.buffer += this.decoder.decode();
    if (this.sse) this.frame(this.buffer);
    else this.parse(this.buffer);
    this.buffer = '';
    this.disabled = true;
  }
}

function isModelEndpoint(input, init) {
  try {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    return method.toUpperCase() === 'POST' && ENDPOINT.test(url.pathname);
  } catch {
    return false;
  }
}

/**
 * 进程级 fetch 观察桥，用 AsyncLocalStorage 把捕获上下文隔离到「单次模型流」里。
 * 引用计数确保插件卸载后恢复原始 fetch；重复安装复用同一个桥。
 */
export function installFetchBridge() {
  let state = globalThis[KEY];
  if (!state) {
    const original = globalThis.fetch;
    const als = new AsyncLocalStorage();
    state = { original, als, count: 0 };
    state.wrapper = async function dshGptImagesFetch(input, init) {
      const capture = als.getStore();
      const response = await original.call(this, input, init);
      if (!capture?.active || !isModelEndpoint(input, init) || !response.ok || !response.body) return response;
      const kind = response.headers.get('content-type') ?? '';
      if (!kind.includes('json') && !kind.includes('text/event-stream')) return response;
      capture.responses++;
      const observer = new WireObserver(kind, capture);
      capture.observers.push(observer);
      const stream = response.body.pipeThrough(
        new TransformStream({
          transform(chunk, controller) {
            observer.feed(chunk);
            controller.enqueue(chunk);
          },
          flush() {
            observer.finish();
          },
        }),
      );
      const wrapped = new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
      for (const key of ['url', 'redirected', 'type']) Object.defineProperty(wrapped, key, { value: response[key] });
      return wrapped;
    };
    globalThis[KEY] = state;
    globalThis.fetch = state.wrapper;
  }
  state.count++;
  let disposed = false;
  return {
    run(capture, callback) {
      return state.als.run(capture, callback);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      state.count--;
      if (state.count === 0) {
        if (globalThis.fetch === state.wrapper) globalThis.fetch = state.original;
        delete globalThis[KEY];
      }
    },
  };
}

export function createCapture(config) {
  const warnings = new Set();
  return {
    active: true,
    images: [],
    keys: new Set(),
    observers: [],
    responses: 0,
    maxResponseBytes: config.maxResponseBytes,
    maxImages: config.maxImages,
    warnings,
    warn(message) {
      warnings.add(message);
    },
    finish() {
      for (const observer of this.observers) observer.finish();
    },
  };
}
