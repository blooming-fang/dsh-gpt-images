import test from 'node:test';
import assert from 'node:assert/strict';
import { extractImages, candidateKey, decodeImage, sniffImage } from '../src/extract.js';

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('OpenAI Responses: 只取最终 image_generation_call，忽略 partial preview', () => {
  const partial = { type: 'response.image_generation_call.partial_image', partial_image_b64: PNG_BASE64 };
  assert.deepEqual(extractImages(partial), []);

  const done = {
    type: 'response.output_item.done',
    item: { type: 'image_generation_call', result: PNG_BASE64, output_format: 'png' },
  };
  const candidates = extractImages(done);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].base64, PNG_BASE64);
  assert.equal(candidates[0].mediaType, 'image/png');
});

test('OpenAI Responses: response.completed 里嵌套 output 也能提取', () => {
  const event = {
    type: 'response.completed',
    response: { output: [{ type: 'image_generation_call', result: PNG_BASE64 }] },
  };
  assert.equal(extractImages(event).length, 1);
});

test('OpenAI Chat: message.images / delta.images / image_url', () => {
  assert.equal(extractImages({ choices: [{ message: { images: [{ type: 'image_url', image_url: { url: 'https://cdn.example.com/a.png' } }] } }] }).length, 1);
  assert.equal(extractImages({ choices: [{ delta: { images: [{ type: 'image_url', image_url: 'https://cdn.example.com/b.png' }] } }] }).length, 1);
  assert.equal(
    extractImages({ choices: [{ message: { content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,' + PNG_BASE64 } }] } }] }).length,
    1,
  );
});

test('Gemini: inlineData / inline_data', () => {
  const a = { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG_BASE64 } }] } }] };
  const b = { candidates: [{ content: { parts: [{ inline_data: { mime_type: 'image/jpeg', data: PNG_BASE64 } }] } }] };
  assert.equal(extractImages(a).length, 1);
  assert.equal(extractImages(b)[0].mediaType, 'image/jpeg');
});

test('Images API: data[].b64_json 与 data[].url', () => {
  assert.equal(extractImages({ data: [{ b64_json: PNG_BASE64 }] }).length, 1);
  assert.equal(extractImages({ data: [{ url: 'https://cdn.example.com/c.png' }] }).length, 1);
});

test('Anthropic: image source base64', () => {
  const value = { content: [{ type: 'image', source: { type: 'base64', media_type: 'image/webp', data: PNG_BASE64 } }] };
  // Anthropic 的 content 在 message 里；直接扫描 message 容器。
  assert.equal(extractImages({ choices: [{ message: value }] }).length, 1);
});

test('不扫描请求提示词或无关字段', () => {
  assert.deepEqual(extractImages({ messages: [{ role: 'user', content: '画一张 https://evil.example.com/x.png' }] }), []);
  assert.deepEqual(extractImages({ type: 'message', content: [{ type: 'text', text: 'https://x/y.png' }] }), []);
});

test('candidateKey 对同一内容稳定且不同内容不同', () => {
  const a = { base64: PNG_BASE64 };
  assert.equal(candidateKey(a), candidateKey({ base64: PNG_BASE64 }));
  assert.notEqual(candidateKey(a), candidateKey({ url: 'https://x/y.png' }));
});

test('decodeImage 校验 base64 并识别格式', () => {
  const png = decodeImage({ base64: PNG_BASE64 }, 1024 * 1024);
  assert.equal(png.ext, 'png');
  assert.equal(png.mediaType, 'image/png');
  assert.ok(png.bytes.length > 0);
  assert.throws(() => decodeImage({ base64: 'not-base64!!' }, 1024 * 1024));
  assert.throws(() => decodeImage({ base64: PNG_BASE64 }, 10));
});

test('sniffImage 拒绝非图片', () => {
  assert.throws(() => sniffImage(Buffer.from('hello world')));
});
