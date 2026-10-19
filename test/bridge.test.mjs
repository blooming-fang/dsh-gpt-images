import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installFetchBridge, createCapture, WireObserver } from '../src/capture.js';
import { captureStream, DEFAULTS, selected } from '../src/bridge.js';
import { createRecentSet } from '../src/storage.js';

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function makeConfig(overrides = {}) {
  return { ...DEFAULTS, ...overrides };
}

function sseBody(events) {
  return new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const event of events) controller.enqueue(encoder.encode('data: ' + JSON.stringify(event) + '\n\n'));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}

function fakeFetchReturning(events) {
  return async () =>
    new Response(sseBody(events), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
}

test('selected 过滤无会话、标题/压缩调用与 provider/model 白名单', () => {
  const config = makeConfig({ providers: ['codex'], models: ['gpt-image-2.5-sunburst'] });
  assert.equal(selected({ sessionId: 's', provider: 'codex', model: 'gpt-image-2.5-sunburst' }, config), true);
  assert.equal(selected({ provider: 'codex', model: 'gpt-image-2.5-sunburst' }, config), false);
  assert.equal(selected({ sessionId: 's', purpose: 'session-title', provider: 'codex', model: 'gpt-image-2.5-sunburst' }, config), false);
  assert.equal(selected({ sessionId: 's', provider: 'other', model: 'gpt-image-2.5-sunburst' }, config), false);
});

test('端到端：图片响应 → 保存到会话目录 → 追加 markdown 预览 → 空回复错误恢复为正常结束', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gpt-images-'));
  const cwd = join(root, 'project');
  const cache = join(root, 'cache');
  const originalFetch = globalThis.fetch;
  // 测试替身必须先于观察桥安装，观察桥才会包住它（真实插件同理：包住全局 fetch）。
  globalThis.fetch = fakeFetchReturning([
    { type: 'response.output_item.done', item: { type: 'image_generation_call', result: PNG_BASE64, output_format: 'png' } },
  ]);
  const bridge = installFetchBridge();
  const config = makeConfig({ cacheDir: cache, downloadRemoteImages: false });
  try {
    async function* adapter() {
      // 真实的适配器会在迭代过程中发起请求；ALS 必须能覆盖到这里。
      const response = await globalThis.fetch('http://127.0.0.1:8317/v1/responses', { method: 'POST' });
      await response.text();
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'EMPTY_RESPONSE', message: 'empty' } }, replayState: { stale: true } };
    }

    const services = {
      resolveOutputDirectory: async () => cwd,
      cacheDirectory: cache,
      baseURL: () => 'http://127.0.0.1:54100/',
      recent: createRecentSet(),
    };
    const chunks = [];
    for await (const chunk of captureStream({ sessionId: 's1', provider: 'codex', model: 'gpt-image-2.5-sunburst' }, adapter, bridge, config, services)) {
      chunks.push(chunk);
    }
    const finish = chunks.at(-1);
    assert.equal(finish.type, 'finish');
    assert.equal(finish.reason.kind, 'stop');
    assert.equal(finish.replayState, undefined);
    const text = chunks
      .filter((chunk) => chunk.type === 'text-delta')
      .map((chunk) => chunk.text)
      .join('');
    assert.match(text, /!\[生成的图片 1\]/);
    assert.match(text, /http:\/\/127\.0\.0\.1:54100\/dsh-gpt-images\/generated-[a-f0-9]{32}\.png/);
  } finally {
    globalThis.fetch = originalFetch;
    await bridge.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('保存失败时把纯图片的空回复错误改成明确的保存失败错误', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gpt-images-'));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetchReturning([{ type: 'response.output_item.done', item: { type: 'image_generation_call', result: PNG_BASE64 } }]);
  const bridge = installFetchBridge();
  const config = makeConfig({ cacheDir: join(root, 'not-a-directory'), maxImageBytes: 4 });
  try {
    async function* adapter() {
      const response = await globalThis.fetch('http://x/v1/responses', { method: 'POST' });
      await response.text();
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'EMPTY_RESPONSE', message: 'empty' } } };
    }
    const services = {
      resolveOutputDirectory: async () => join(root, 'project'),
      cacheDirectory: join(root, 'not-a-directory'),
      recent: createRecentSet(),
    };
    const chunks = [];
    for await (const chunk of captureStream({ sessionId: 's1' }, adapter, bridge, config, services)) chunks.push(chunk);
    const finish = chunks.at(-1);
    assert.equal(finish.reason.kind, 'error');
    assert.equal(finish.reason.failure.code, 'IMAGE_OUTPUT_SAVE_FAILED');
  } finally {
    globalThis.fetch = originalFetch;
    await bridge.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('适配器已产出原生 image 块时不重复保存', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gpt-images-'));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetchReturning([{ type: 'response.output_item.done', item: { type: 'image_generation_call', result: PNG_BASE64 } }]);
  const bridge = installFetchBridge();
  const config = makeConfig({ cacheDir: join(root, 'cache') });
  try {
    async function* adapter() {
      const response = await globalThis.fetch('http://x/v1/responses', { method: 'POST' });
      await response.text();
      yield { type: 'block-start', index: 0, blockType: 'image' };
      yield { type: 'block-end', index: 0, block: { type: 'image', attachment: { attachmentId: 'a' } } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
    const calls = [];
    const services = {
      resolveOutputDirectory: async () => {
        calls.push('called');
        return join(root, 'project');
      },
      cacheDirectory: join(root, 'cache'),
      recent: createRecentSet(),
    };
    const chunks = [];
    for await (const chunk of captureStream({ sessionId: 's1' }, adapter, bridge, config, services)) chunks.push(chunk);
    assert.deepEqual(calls, []);
    assert.equal(chunks.some((chunk) => chunk.type === 'text-delta'), false);
  } finally {
    globalThis.fetch = originalFetch;
    await bridge.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('SSE 观察器按帧提取图片，非 SSE 在结束时解析整段 JSON', () => {
  const capture = createCapture(makeConfig());
  const observer = new WireObserver('application/json', capture);
  observer.feed(new TextEncoder().encode(JSON.stringify({ data: [{ b64_json: PNG_BASE64 }] })));
  observer.finish();
  assert.equal(capture.images.length, 1);

  const capture2 = createCapture(makeConfig());
  const sse = new WireObserver('text/event-stream', capture2);
  sse.feed(new TextEncoder().encode('data: {"choices":[{"delta":{"images":[{"type":"image_url","image_url":{"url":"https://cdn.example.com/a.png"}}]}}]}\n\n'));
  sse.finish();
  assert.equal(capture2.images.length, 1);
});
