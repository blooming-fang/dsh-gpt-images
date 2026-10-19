import { createHash } from 'node:crypto';

/**
 * 只在响应的「输出容器」里找图片，绝不扫描请求内容、提示词、工具参数或任意 URL。
 * 覆盖：OpenAI Chat Completions / Responses、Gemini generateContent、
 * Anthropic messages、Images API，以及 OpenRouter 的 message.images。
 */

const IMAGE_PART_TYPES = new Set(['image', 'image_url', 'output_image', 'input_image']);

function pushCandidate(found, source, mediaType) {
  if (typeof source !== 'string' || source.length === 0) return;
  if (source.startsWith('data:')) {
    const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/.exec(source);
    if (match) found.push({ base64: match[2], mediaType: match[1] });
    return;
  }
  if (/^https?:\/\//i.test(source)) {
    found.push({ url: source });
    return;
  }
  // 纯 base64（OpenAI Responses 的 image_generation_call.result / Images API）。
  found.push({ base64: source, mediaType });
}

function fromPart(found, part) {
  if (!part || typeof part !== 'object') return;
  // Gemini：{ inlineData: { data, mimeType } } / { inline_data: {...} }
  const inline = part.inlineData ?? part.inline_data;
  if (inline && typeof inline === 'object') {
    const mime = inline.mimeType ?? inline.mime_type ?? inline.mime;
    pushCandidate(found, inline.data, mime);
  }
  // OpenAI Responses：{ type: 'image_generation_call', result: '<base64>', output_format }
  if (part.type === 'image_generation_call' && typeof part.result === 'string') {
    const format = typeof part.output_format === 'string' ? part.output_format : '';
    const mediaType =
      format === 'jpeg' || format === 'jpg'
        ? 'image/jpeg'
        : format === 'webp'
          ? 'image/webp'
          : format === 'gif'
            ? 'image/gif'
            : 'image/png';
    pushCandidate(found, part.result, mediaType);
  }
  // Anthropic：{ type: 'image', source: { type: 'base64', media_type, data } | { type: 'url', url } }
  if (part.type === 'image' && part.source && typeof part.source === 'object') {
    if (part.source.type === 'base64') pushCandidate(found, part.source.data, part.source.media_type);
    else if (part.source.type === 'url') pushCandidate(found, part.source.url, part.source.media_type);
  }
  // OpenAI Chat / OpenRouter 风格：{ type: 'image_url', image_url: { url } | '<url>' }
  if (IMAGE_PART_TYPES.has(part.type)) {
    const value = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url ?? part.url ?? part.data;
    pushCandidate(found, value, part.mime_type ?? part.media_type ?? part.mediaType);
  }
  // Images API 风格：{ b64_json } / { url }
  if (typeof part.b64_json === 'string') pushCandidate(found, part.b64_json, part.mime_type ?? part.media_type);
  if (typeof part.url === 'string' && (part.type === 'image_url' || part.b64_json === undefined) && !part.type) pushCandidate(found, part.url);
}

function fromContent(found, parts) {
  if (Array.isArray(parts)) for (const part of parts) fromPart(found, part);
}

function fromMessage(found, message) {
  if (!message || typeof message !== 'object') return;
  fromContent(found, message.content);
  fromContent(found, message.images);
}

/** 返回去重前的图片候选；调用方负责按 candidateKey 去重。 */
export function extractImages(value) {
  const found = [];
  if (!value || typeof value !== 'object') return found;

  // OpenAI Responses 的 partial preview 不是最终图，必须忽略，否则会重复保存。
  if (typeof value.type === 'string' && value.type.includes('partial_image')) return found;

  // Responses 流式事件：最终 item / 完整 response。
  if (value.type === 'response.output_item.done') fromPart(found, value.item);
  if (value.type === 'response.completed' && value.response) found.push(...extractImages(value.response));

  // Responses 非流式最终对象。
  if (Array.isArray(value.output)) {
    for (const item of value.output) {
      fromPart(found, item);
      if (item && item.type === 'message') fromContent(found, item.content);
    }
  }

  // OpenAI Chat Completions / OpenRouter。
  if (Array.isArray(value.choices)) {
    for (const choice of value.choices) {
      fromMessage(found, choice?.message);
      fromMessage(found, choice?.delta);
    }
  }

  // Gemini generateContent / streamGenerateContent。
  if (Array.isArray(value.candidates)) {
    for (const candidate of value.candidates) fromContent(found, candidate?.content?.parts);
  }

  // Images API / 兼容网关的非流式图片结果。
  if (Array.isArray(value.data)) {
    for (const part of value.data) fromPart(found, part);
  }

  // 某些网关的流式图片事件：{ type: 'image_generation.completed', b64_json }
  if (value.type === 'image_generation.completed' && typeof value.b64_json === 'string') {
    pushCandidate(found, value.b64_json, value.mime_type ?? value.media_type);
  }

  return found;
}

export function candidateKey(candidate) {
  return createHash('sha256').update(candidate.url ?? candidate.base64).digest('hex');
}

/** 按文件头识别真实格式，不信任文件名或远端 Content-Type。 */
export function sniffImage(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { mediaType: 'image/png', ext: 'png' };
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { mediaType: 'image/jpeg', ext: 'jpg' };
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return { mediaType: 'image/webp', ext: 'webp' };
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return { mediaType: 'image/gif', ext: 'gif' };
  throw new Error('图片数据不是受支持的 PNG / JPEG / WebP / GIF，未保存为图片。');
}

/** 严格校验并解码 base64，同时应用单图字节上限。 */
export function decodeImage(candidate, maxBytes) {
  const text = candidate.base64.replace(/\s/g, '');
  if (!text || text.length > Math.ceil(maxBytes / 3) * 4) throw new Error('图片 base64 无效或超过大小限制。');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 === 1) throw new Error('图片 base64 无效或超过大小限制。');
  const bytes = Buffer.from(text, 'base64');
  if (!bytes.length || bytes.length > maxBytes) throw new Error('图片 base64 无效或超过大小限制。');
  if (bytes.toString('base64').replace(/=+$/, '') !== text.replace(/=+$/, '')) throw new Error('图片 base64 无效或超过大小限制。');
  return { bytes, ...sniffImage(bytes) };
}
