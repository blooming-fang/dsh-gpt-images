import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveImages, imageMarkdown, createRecentSet, FILE_NAME } from '../src/storage.js';

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function fixture() {
  const capture = {
    images: [{ base64: PNG_BASE64 }],
    warnings: new Set(),
    warn(message) {
      this.warnings.add(message);
    },
  };
  const config = {
    maxImageBytes: 1024 * 1024,
    downloadRemoteImages: false,
    downloadTimeoutMs: 5000,
    cacheDir: '',
    publicBaseURL: '',
    subdirectory: '',
  };
  return { capture, config };
}

test('saveImages 同时写入会话目录与缓存目录，并生成可预览 markdown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gpt-images-'));
  const cwd = join(root, 'project');
  const cache = join(root, 'cache');
  try {
    const { capture, config } = fixture();
    config.cacheDir = cache;
    const services = { resolveOutputDirectory: async () => cwd, cacheDirectory: cache, recent: createRecentSet() };
    const saved = await saveImages(capture, { sessionId: 's1', provider: 'p', model: 'm' }, config, services);
    assert.equal(saved.length, 1);
    const [image] = saved;
    assert.match(image.filename, FILE_NAME);
    assert.equal((await readFile(join(cwd, image.filename))).length, (await readFile(join(cache, image.filename))).length);
    assert.ok((await stat(image.path)).isFile());
    assert.ok((await stat(image.cachePath)).isFile());

    const markdown = imageMarkdown(saved, config, 'http://127.0.0.1:54100/');
    assert.match(markdown, /!\[生成的图片 1\]\(<http:\/\/127\.0\.0\.1:54100\/dsh-gpt-images\/generated-[a-f0-9]{32}\.png>\)/);
    assert.match(markdown, /下载原图/);
    assert.match(markdown, new RegExp(image.path.replaceAll('\\', '/').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('没有 Web 根地址时降级为纯本地路径说明，不渲染坏图', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gpt-images-'));
  try {
    const { config } = fixture();
    config.cacheDir = join(root, 'cache');
    const markdown = imageMarkdown(
      [{ filename: 'generated-' + 'b'.repeat(32) + '.png', cachePath: join(root, 'cache', 'x.png'), path: join(root, 'project', 'x.png') }],
      config,
      '',
    );
    assert.doesNotMatch(markdown, /!\[/);
    assert.match(markdown, /预览地址不可用/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('同内容在重试窗口内只保存一次', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gpt-images-'));
  const cache = join(root, 'cache');
  try {
    const { capture, config } = fixture();
    config.cacheDir = cache;
    const services = { resolveOutputDirectory: async () => join(root, 'project'), cacheDirectory: cache, recent: createRecentSet() };
    assert.equal((await saveImages(capture, { sessionId: 's1' }, config, services)).length, 1);
    assert.equal((await saveImages(capture, { sessionId: 's1' }, config, services)).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('会话目录不可写时仍保留缓存副本并给出提示', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gpt-images-'));
  const cache = join(root, 'cache');
  try {
    const { capture, config } = fixture();
    config.cacheDir = cache;
    const services = {
      resolveOutputDirectory: async () => {
        throw new Error('no session');
      },
      cacheDirectory: cache,
      recent: createRecentSet(),
    };
    const saved = await saveImages(capture, { sessionId: 's1' }, config, services);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].path, undefined);
    assert.ok(saved[0].cachePath);
    assert.match([...capture.warnings].join(' '), /无法确定会话当前目录/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('publicBaseURL 生成绝对链接并保留挂载路径', () => {
  const { config } = fixture();
  config.publicBaseURL = 'https://dsh.example.com/ui/';
  const markdown = imageMarkdown([{ filename: 'generated-' + 'a'.repeat(32) + '.png', cachePath: 'x', path: 'y' }], config, '');
  assert.match(markdown, /https:\/\/dsh\.example\.com\/ui\/dsh-gpt-images\/generated-/);
});
