import test from 'node:test';
import assert from 'node:assert/strict';
import { galleryScript } from '../src/presentation.js';

const { JSDOM } = await import(process.env.DSH_TEST_JSDOM || 'jsdom');
const filename = (id = 'a') => 'generated-' + id.repeat(32) + '.png';
const imageURL = (id = 'a', path) => {
  const url = new URL('/dsh-gpt-images/' + filename(id), 'http://localhost');
  if (path !== undefined) url.searchParams.set('dgi_path', path);
  return url.href;
};
const escape = (text) => String(text).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
const nativeOptions = {
  revealToken: 'offline-reveal-token', revealEndpoint: 'http://localhost/dsh-gpt-images/reveal',
  referenceToken: 'offline-reference-token', referenceEndpoint: 'http://localhost/dsh-gpt-images/reference',
};
function setup(html, options = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body>' + html + '</body></html>', {
    url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true,
    // No resources loader: jsdom cannot fetch an image, script, stylesheet or network fixture.
  });
  const w = dom.window;
  const calls = [];
  w.matchMedia = () => ({ matches: true });
  w.ResizeObserver = class { observe() {} disconnect() {} };
  w.HTMLElement.prototype.scrollBy = function ({ left }) { this.scrollLeft += left; };
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event('close')); };
  // Presence is sufficient for rendering the reference action; no paste or real API request is made.
  w.DataTransfer = class {};
  w.ClipboardEvent = class extends w.Event {};
  w.fetch = async (endpoint, options) => {
    calls.push({ endpoint, options });
    assert.equal(new URL(endpoint).pathname, '/dsh-gpt-images/reveal', 'Only offline reveal mocks may be called');
    return { ok: true, json: async () => ({ ok: true, location: 'primary', selected: true, foreground: true }) };
  };
  w.eval(galleryScript({ ...nativeOptions, ...options }));
  const settle = () => new Promise((resolve) => w.requestAnimationFrame(() => w.requestAnimationFrame(resolve)));
  const dispose = () => { w.__dshGptImagesGallery?.dispose(); w.close(); };
  return { w, d: w.document, calls, settle, dispose };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
function hasActions(card) {
  assert.ok(card, 'The rewritten assistant image must produce a gallery card');
  assert.ok(card.querySelector('button[aria-label="引用"]'));
  assert.ok(card.querySelector('button[aria-label="打开文件夹"]'));
  assert.equal([...card.querySelectorAll('a')].find((a) => a.textContent === '原图')?.target, '_blank');
  assert.equal(card.querySelectorAll('a[download]').length, 0);
}
function visibleSourceIsHidden(t, source) {
  assert.ok(source.isConnected, 'React-owned original img must remain connected');
  assert.equal(source.getAttribute('data-dgi-source'), 'hidden');
  assert.equal(t.w.getComputedStyle(source).display, 'none');
}

test('改写的助手标题、去海边吧alt与下载文案仍增强，正文和原节点完整保留且图片不重复显示', async () => {
  const url = imageURL();
  const t = setup('<div id="reply"><h3 id="title">去海边吧｜一张阳光明媚的旅行海报</h3><p id="intro">已经做好了，点击下方查看高清版本。</p>' +
    '<p id="source-p"><img id="original" alt="去海边吧" src="' + url + '"></p>' +
    '<p id="rewritten-download"><a href="' + url + '?download=1">点这里保存这张海报</a>，也可以继续告诉我修改要求。</p></div>');
  try {
    const original = t.d.querySelector('#original');
    await t.settle();
    assert.equal(t.d.querySelectorAll('.dgi-gallery').length, 1);
    assert.equal(t.d.querySelectorAll('.dgi-card').length, 1);
    hasActions(t.d.querySelector('.dgi-card'));
    visibleSourceIsHidden(t, original);
    assert.equal(t.d.querySelector('#original'), original);
    assert.equal(t.d.querySelectorAll('.dgi-card img').length, 1);
    assert.equal(t.d.querySelector('.dgi-card img').alt, '去海边吧');
    for (const id of ['title', 'intro', 'rewritten-download']) {
      const node = t.d.getElementById(id);
      assert.equal(node.hasAttribute('data-dgi-source'), false);
      assert.notEqual(t.w.getComputedStyle(node).display, 'none');
    }
    assert.equal(t.d.querySelector('#rewritten-download').textContent, '点这里保存这张海报，也可以继续告诉我修改要求。');
    assert.equal(t.calls.length, 0);
    t.w.__dshGptImagesGallery.dispose();
    assert.equal(original.hasAttribute('data-dgi-source'), false);
    assert.equal(t.d.querySelector('.dgi-gallery'), null);
    assert.equal(t.d.querySelector('#title').textContent, '去海边吧｜一张阳光明媚的旅行海报');
  } finally { t.dispose(); }
});

test('空alt或省略alt且没有metadata也生成单图画廊，aria-label有安全回退', async (context) => {
  for (const alt of ['alt=""', '']) await context.test(alt || 'no alt attribute', async () => {
    const t = setup('<div><p><img id="source" ' + alt + ' src="' + imageURL() + '"></p></div>');
    try {
      await t.settle();
      const card = t.d.querySelector('.dgi-card');
      hasActions(card);
      assert.ok(card.getAttribute('aria-label').trim());
      assert.ok(card.querySelector('img').alt.trim());
      assert.equal(t.d.querySelector('.dgi-gallery').dataset.single, 'true');
      visibleSourceIsHidden(t, t.d.getElementById('source'));
    } finally { t.dispose(); }
  });
});

test('dgi_path从工具图片URL恢复真实保存位置，不依赖已保存到code或固定下载标签', async () => {
  const path = 'D:/旅行素材/去海边吧 中文 空格/' + filename();
  const url = imageURL('a', path);
  const t = setup('<div><p><img alt="去海边吧" src="' + escape(url) + '"></p><p id="description">已完成，<a href="' + escape(url + '&download=1') + '">高清版本</a>在这里。</p></div>');
  try {
    await t.settle();
    const card = t.d.querySelector('.dgi-card');
    hasActions(card);
    assert.equal(card.querySelector('.dgi-path').textContent, path);
    assert.equal(t.d.querySelector('#description').hasAttribute('data-dgi-source'), false);
    assert.equal(new URL(card.querySelector('.dgi-actions a').href).searchParams.get('dgi_path'), path);
    card.querySelector('button[aria-label="打开文件夹"]').click();
    await flush();
    assert.equal(t.calls.length, 1);
    assert.equal(t.calls[0].endpoint, 'http://localhost/dsh-gpt-images/reveal');
    assert.deepEqual(JSON.parse(t.calls[0].options.body), { filename: filename(), path });
    assert.match(t.d.querySelector('.dgi-toast').textContent, /已打开文件夹并选中图片/);
  } finally { t.dispose(); }
});

test('恶意dgi_path控制字符不能进入位置UI、复制或打开文件夹请求', async (context) => {
  for (const control of ['\0', '\r', '\n', '\t', '\u001b', '\u007f']) await context.test('U+' + control.charCodeAt(0).toString(16).padStart(4, '0'), async () => {
    const malicious = 'D:/旅行素材/unsafe' + control + '/'+ filename();
    const t = setup('<div><p><img src="' + escape(imageURL('a', malicious)) + '" alt="去海边吧"></p></div>');
    try {
      await t.settle();
      const card = t.d.querySelector('.dgi-card');
      hasActions(card);
      assert.equal(card.querySelector('.dgi-path'), null, 'Unsafe path hints are ignored, not presented as trusted locations');
      assert.equal(card.querySelector('button[aria-label="复制路径"]'), null);
      card.querySelector('button[aria-label="打开文件夹"]').click();
      await flush();
      const body = JSON.parse(t.calls[0].options.body);
      assert.equal(body.filename, filename());
      assert.ok(!body.path, 'Do not forward control-character path hints to the native endpoint');
    } finally { t.dispose(); }
  });
});

test('旧图片缺少路径query与metadata时从cacheDirectory恢复可用位置', async () => {
  const cacheDirectory = 'D:/DSH 缓存/图片';
  const t = setup('<div><p><img src="' + imageURL() + '" alt="历史中的海报"></p></div>', { cacheDirectory });
  try {
    await t.settle();
    const card = t.d.querySelector('.dgi-card');
    hasActions(card);
    assert.equal(card.querySelector('.dgi-path').textContent.replaceAll('\\', '/'), cacheDirectory + '/' + filename());
    card.querySelector('button[aria-label="打开文件夹"]').click();
    await flush();
    const payload = JSON.parse(t.calls[0].options.body);
    assert.equal(payload.filename, filename());
    assert.equal(payload.path.replaceAll('\\', '/'), cacheDirectory + '/' + filename());
  } finally { t.dispose(); }
});

test('普通外部图片、伪造URL与不合法插件filename不会增强或被隐藏', async (context) => {
  const valid = filename();
  const invalid = [
    'https://external.invalid/photo.png',
    'http://localhost/photos/' + valid + '?pretend=/dsh-gpt-images/' + valid,
    'http://localhost/dsh-gpt-images-evil/' + valid,
    'http://localhost/dsh-gpt-images/generated-' + 'g'.repeat(32) + '.png',
    'http://localhost/dsh-gpt-images/generated-' + 'a'.repeat(31) + '.png',
    'http://localhost/dsh-gpt-images/generated-' + 'a'.repeat(33) + '.png',
    'http://localhost/dsh-gpt-images/generated-' + 'a'.repeat(32) + '.svg',
    'http://localhost/dsh-gpt-images/' + valid + '/extra',
    'http://localhost/dsh-gpt-images/' + valid + '.html',
    'http://user:password@localhost/dsh-gpt-images/' + valid,
    'data:image/png;base64,AA==',
  ];
  for (const url of invalid) await context.test(url.replace('user:password@', ''), async () => {
    const t = setup('<div><p id="source-p"><img id="source" src="' + escape(url) + '" alt="生成的图片 1"></p><p>普通图片正文应保持可见。</p></div>');
    try {
      await t.settle();
      assert.equal(t.d.querySelector('.dgi-gallery'), null);
      assert.equal(t.d.querySelector('[data-dgi-source]'), null);
      assert.notEqual(t.w.getComputedStyle(t.d.getElementById('source')).display, 'none');
    } finally { t.dispose(); }
  });
});

test('独立publicBaseURL主机上的合法插件图片仍增强，不把普通外图一概当成本地资源', async () => {
  const remote = imageURL().replace('http://localhost', 'https://public-images.invalid');
  const t = setup('<div><p><img id="source" src="' + remote + '" alt="去海边吧"></p></div>');
  try {
    await t.settle();
    const card = t.d.querySelector('.dgi-card');
    hasActions(card);
    assert.equal(card.querySelector('.dgi-actions a').href, remote);
    visibleSourceIsHidden(t, t.d.getElementById('source'));
    assert.equal(t.calls.length, 0);
  } finally { t.dispose(); }
});

test('流式改写alt不会撤销合法插件图增强，改为普通外部src后完整恢复来源', async () => {
  const t = setup('<div id="reply"><p><img id="source" src="' + imageURL() + '" alt="生成的图片 1"></p><p id="body">保留原始说明。</p></div>');
  try {
    await t.settle();
    const source = t.d.getElementById('source');
    const gallery = t.d.querySelector('.dgi-gallery');
    source.alt = '去海边吧';
    await t.settle();
    assert.equal(t.d.querySelector('.dgi-gallery'), gallery);
    assert.equal(t.d.querySelectorAll('.dgi-card').length, 1);
    assert.equal(t.d.querySelector('.dgi-card img').alt, '去海边吧');
    visibleSourceIsHidden(t, source);
    source.src = 'https://external.invalid/ordinary.png';
    await t.settle();
    assert.equal(t.d.querySelector('.dgi-gallery'), null);
    assert.equal(source.hasAttribute('data-dgi-source'), false);
    assert.equal(source.closest('p').hasAttribute('data-dgi-source'), false);
    assert.equal(t.d.getElementById('body').textContent, '保留原始说明。');
  } finally { t.dispose(); }
});

test('图片同段新增模型正文时只隐藏原img，不隐藏正文段落', async () => {
  const t = setup('<div><p id="mixed">这是保留的模型说明 <img id="source" src="' + imageURL() + '" alt="去海边吧"> 点击卡片继续修改。</p></div>');
  try {
    await t.settle();
    hasActions(t.d.querySelector('.dgi-card'));
    visibleSourceIsHidden(t, t.d.getElementById('source'));
    assert.equal(t.d.getElementById('mixed').hasAttribute('data-dgi-source'), false);
    assert.notEqual(t.w.getComputedStyle(t.d.getElementById('mixed')).display, 'none');
    assert.equal(t.d.getElementById('mixed').textContent, '这是保留的模型说明  点击卡片继续修改。');
  } finally { t.dispose(); }
});
