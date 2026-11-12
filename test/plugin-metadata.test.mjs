import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Guards the plugin metadata the host reads without loading plugin code:
// package.json.icon becomes a data URL in the plugin card, and
// <package>/locale/<language>.json supplies the localized title and description.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
/** Mirrors the host limits for a manifest icon. */
const ICON_MEDIA_TYPES = ['.svg', '.png', '.jpg', '.jpeg', '.webp'];
const MAX_ICON_BYTES = 256 * 1024;
/** A plugin meta file is only resolved when the exports map covers this pattern. */
const LOCALE_PATTERN = './locale/*.json';

/** Answer whether a resolved path stays inside the package directory. */
function insideRoot(file) {
  const local = relative(root, file);
  return local !== '..' && !local.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) && !local.startsWith('/');
}

test('插件图标声明为包内相对路径，扩展名与体积符合宿主限制', async () => {
  assert.equal(typeof manifest.icon, 'string');
  assert.ok(manifest.icon.startsWith('./'));
  const file = resolve(root, manifest.icon);
  assert.ok(insideRoot(file), 'icon must remain inside the package directory');
  assert.ok(ICON_MEDIA_TYPES.includes(extname(file).toLowerCase()), 'icon must be SVG, PNG, JPEG or WebP');
  const info = await stat(file);
  assert.ok(info.isFile());
  assert.ok(info.size <= MAX_ICON_BYTES, 'icon exceeds 256 KiB');
  const text = await readFile(file, 'utf8');
  assert.match(text, /^<svg[\s>]/, 'icon should be an SVG document');
  assert.match(text, /viewBox="0 0 36 36"/, 'icon should use the 36 unit artwork grid');
});

test('导出映射覆盖语言文件与 package.json，宿主才能解析元数据', () => {
  assert.equal(manifest.exports['./' + LOCALE_PATTERN.slice(2)], LOCALE_PATTERN);
  assert.equal(manifest.exports['./package.json'], './package.json');
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml');
  const files = manifest.files ?? [];
  assert.ok(files.includes('icon.svg'), 'npm package must ship icon.svg');
  assert.ok(files.includes(LOCALE_PATTERN.slice(2)), 'npm package must ship its locale files');
});

test('中英文元数据齐全，标题与描述都非空且语言间不同', async () => {
  const directory = join(root, 'locale');
  const names = (await readdir(directory)).filter((name) => name.endsWith('.json'));
  assert.ok(names.includes('en.json'), 'the host resolves locale/en.json first');
  assert.ok(names.includes('zh.json'), 'Chinese display text is required');
  const titles = new Map();
  const descriptions = new Map();
  for (const name of names) {
    const resource = './locale/' + name;
    assert.match(resource, /^\.\/locale\/[^/]+\.json$/, 'locale resource must match the exports pattern');
    const parsed = JSON.parse(await readFile(join(directory, name), 'utf8'));
    const meta = parsed.meta;
    assert.equal(typeof meta?.title, 'string');
    assert.ok(meta.title.trim() !== '', name + ' meta.title must not be empty');
    assert.equal(typeof meta?.description, 'string');
    assert.ok(meta.description.trim() !== '', name + ' meta.description must not be empty');
    titles.set(name, meta.title);
    descriptions.set(name, meta.description);
  }
  assert.notEqual(titles.get('en.json'), titles.get('zh.json'));
  assert.notEqual(descriptions.get('en.json'), descriptions.get('zh.json'));
  assert.match(titles.get('zh.json'), /[\u4e00-\u9fff]/, 'Chinese title should contain Chinese text');
  assert.match(descriptions.get('zh.json'), /[\u4e00-\u9fff]/, 'Chinese description should contain Chinese text');
});

test('清单版本与包名保持可发布状态', () => {
  assert.equal(manifest.name, 'dsh-gpt-images');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.main, './src/index.js');
});
