import { createCapture } from './capture.js';
import { saveImages, imageMarkdown } from './storage.js';

export const DEFAULTS = Object.freeze({
  enabled: true,
  providers: [],
  models: [],
  outputDir: '',
  subdirectory: '',
  cacheDir: '',
  publicBaseURL: '',
  maxImageBytes: 20 * 1024 * 1024,
  maxResponseBytes: 96 * 1024 * 1024,
  maxImages: 20,
  downloadRemoteImages: true,
  downloadTimeoutMs: 30000,
  allowPrivateImageHosts: false,
});

/** 只处理会话内的真实模型调用；标题压缩、无会话调用不捕获。 */
export function selected(options, config) {
  return Boolean(
    config.enabled &&
      options.sessionId &&
      !options.purpose &&
      (!config.providers.length || config.providers.includes(options.provider)) &&
      (!config.models.length || config.models.includes(options.model)),
  );
}

/**
 * 包住单次模型流：原样转发文本/工具/用量/结束块，只在流结束后处理图片。
 * 不修改请求，不重发请求，不吞掉鉴权、配额、传输、截断或取消错误。
 */
export async function* captureStream(options, next, bridge, config, services) {
  if (!selected(options, config)) {
    yield* next();
    return;
  }
  const capture = createCapture(config);
  let iterator;
  let closed = false;
  let highestIndex = -1;
  let finish;
  let usage;
  let nativeImages = false;
  try {
    iterator = bridge.run(capture, () => next()[Symbol.asyncIterator]());
    while (true) {
      const item = await bridge.run(capture, () => iterator.next());
      if (item.done) {
        closed = true;
        break;
      }
      const chunk = item.value;
      if (typeof chunk.index === 'number') highestIndex = Math.max(highestIndex, chunk.index);
      if (chunk.type === 'block-end' && chunk.block?.type === 'image') nativeImages = true;
      if (chunk.type === 'usage') {
        usage = chunk;
        continue;
      }
      if (chunk.type === 'finish') {
        finish = chunk;
        if (iterator.return) await bridge.run(capture, () => iterator.return());
        closed = true;
        break;
      }
      yield chunk;
    }
    capture.finish();

    // 适配器已经产出原生 image 块时不再重复保存/追加，避免同一张图出现两次。
    let saved = [];
    if (!nativeImages) {
      const aborted = Boolean(options.signal?.aborted);
      const saveOptions = aborted ? { ...options, signal: undefined } : options;
      try {
        saved = await saveImages(capture, saveOptions, config, services);
      } catch (error) {
        // 保存阶段的异常不能把一次成功的模型调用变成失败；只记录提示。
        capture.warn('图片保存过程出现异常，原图片可能未完整保存。');
      }
      let text = saved.length ? imageMarkdown(saved, config, services.baseURL?.() ?? '') : '';
      if (capture.warnings.size) text += (text ? '\n\n' : '') + '图片处理提示：' + [...capture.warnings].join(' ');
      if (text) {
        // provider 私有的 replayState 不包含追加的 Markdown；丢掉过期快照，
        // 让下一轮按持久化后的文本重新序列化。
        if (finish && finish.replayState !== undefined) {
          const { replayState, ...withoutReplay } = finish;
          finish = withoutReplay;
        }
        const index = highestIndex + 1;
        yield { type: 'block-start', index, blockType: 'text' };
        yield { type: 'text-delta', index, text: '\n\n' + text };
        yield { type: 'block-end', index, block: { type: 'text', text: '\n\n' + text } };
      }
      // 只把「纯图片响应被翻译成空回复」这一种已知情况恢复为正常结束；
      // 其余失败保持原样，插件从不重试生图。
      const emptyFailure =
        finish?.reason?.kind === 'error' &&
        ['EMPTY_RESPONSE', 'EMPTY_CONTENT', 'NO_CONTENT'].includes(finish.reason.failure?.code);
      if (emptyFailure && saved.length) {
        finish = { type: 'finish', reason: { kind: 'stop' } };
      } else if (emptyFailure && capture.images.length) {
        finish = {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: {
              code: 'IMAGE_OUTPUT_SAVE_FAILED',
              message: '模型已返回图片，但图片保存失败。请检查保存目录和限制；插件不会再次请求生图。',
            },
          },
        };
      }
    }
    if (usage) yield usage;
    if (finish) yield finish;
  } finally {
    capture.active = false;
    capture.images.length = 0;
    capture.observers.length = 0;
    if (iterator && !closed && iterator.return) {
      try {
        await bridge.run(capture, () => iterator.return());
      } catch {
        // 取消路径上的清理失败不再抛出。
      }
    }
  }
}
