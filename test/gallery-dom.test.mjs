import test from 'node:test';
import assert from 'node:assert/strict';
import { galleryScript } from '../src/presentation.js';

// Optional override allows the workspace's already-installed jsdom to be used
// offline. Normal development uses the declared devDependency: npm install.
const { JSDOM } = await import(process.env.DSH_TEST_JSDOM || 'jsdom');
const url = (id) => 'http://localhost/dsh-gpt-images/generated-' + id.repeat(32) + '.png';
function source(id, index = 1) {
  const u = url(id);
  return '<p><img alt="生成的图片 ' + index + '" src="' + u + '"></p><p><a href="' + u + '?download=1">下载原图</a> · 已保存到 <code>D:/输出/' + id + '.png</code></p>';
}
function setup(html, { dialog = true, nativeOptions = {}, pageURL = 'http://localhost/' } = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body>' + html + '</body></html>', { url: pageURL, runScripts: 'outside-only', pretendToBeVisual: true });
  const { window: w } = dom;
  w.matchMedia = () => ({ matches: true });
  let disconnected = 0;
  w.ResizeObserver = class { observe() {} disconnect() { disconnected++; } };
  w.HTMLElement.prototype.scrollBy = function({left}) { this.scrollLeft += left; this.dispatchEvent(new w.Event('scroll')); };
  if (dialog) {
    w.HTMLDialogElement.prototype.showModal = function() { this.open = true; };
    w.HTMLDialogElement.prototype.close = function() { this.open = false; this.dispatchEvent(new w.Event('close')); };
  } else { w.HTMLDialogElement.prototype.showModal = undefined; w.HTMLDialogElement.prototype.close = undefined; }
  w.eval(galleryScript(nativeOptions));
  const settle = () => new Promise((resolve) => w.requestAnimationFrame(() => w.requestAnimationFrame(resolve)));
  const dispose = () => { w.__dshGptImagesGallery?.dispose(); w.close(); };
  return { w, d: w.document, settle, dispose, disconnected: () => disconnected };
}

test('分组只在单个Markdown内，原React节点与正文保留，多图单一横向列表', async () => {
  const t = setup('<div id="a"><p id="prose">正文</p><hr><h3>图片结果 · 2 张</h3>' + source('a') + source('b',2) + '</div><div id="b">' + source('c') + '</div><div><p><img src="' + url('d') + '" alt="普通图片"></p></div>');
  try {
    const original = t.d.querySelector('#a img');
    await t.settle();
    assert.equal(t.d.querySelectorAll('.dgi-gallery').length, 2);
    assert.equal(t.d.querySelectorAll('#a .dgi-card').length, 2);
    assert.equal(t.d.querySelector('#a img'), original);
    assert.equal(original.isConnected, true);
    assert.equal(t.d.querySelector('#prose').hasAttribute('data-dgi-source'), false);
    assert.equal(t.d.querySelector('#a .dgi-track').style.flexWrap, '');
    assert.equal(t.d.querySelector('#a .dgi-count').textContent, '2');
    assert.equal(t.d.querySelector('#b .dgi-gallery').dataset.single, 'true');
    assert.equal(t.w.getComputedStyle(t.d.querySelector('#a h3')).display, 'none');
    assert.equal(t.w.getComputedStyle(t.d.querySelector('#a .dgi-actions button[hidden]')).display, 'none');
    assert.equal(t.d.querySelectorAll('img[alt="普通图片"][data-dgi-source]').length, 0);
  } finally { t.dispose(); }
});

test('追加图片保留现有卡片，并能从React替换/移除中恢复', async () => {
  const t = setup('<div id="root">' + source('a') + '</div>');
  try {
    await t.settle(); const root = t.d.querySelector('#root'); const card = root.querySelector('.dgi-card');
    root.insertAdjacentHTML('beforeend', source('b',2)); await t.settle();
    assert.equal(root.querySelector('.dgi-card'), card); assert.equal(root.querySelectorAll('.dgi-card').length, 2);
    root.querySelector('.dgi-gallery').remove(); await t.settle();
    assert.equal(root.querySelectorAll('.dgi-gallery').length, 1);
    const p = root.querySelector('p'); p.textContent = '更新后的正文'; await t.settle();
    assert.equal(p.hasAttribute('data-dgi-source'), false);
    assert.equal(root.querySelectorAll('.dgi-card').length, 1);
    root.remove(); await t.settle(); assert.equal(t.disconnected(), 1);
  } finally { t.dispose(); }
});

test('仅修改alt也撤销增强，不吞metadata追加正文', async () => {
  const t = setup('<div id="root">' + source('a') + source('b',2) + '</div>');
  try {
    await t.settle(); const root = t.d.querySelector('#root'); const first = root.querySelector('img');
    first.alt = '普通图片'; await t.settle(); assert.equal(first.hasAttribute('data-dgi-source'), false);
    const metadata = [...root.querySelectorAll('p')].find((p) => p.textContent.includes('b.png'));
    metadata.append(t.d.createTextNode(' 额外说明需要保留')); await t.settle();
    assert.equal(metadata.hasAttribute('data-dgi-source'), false);
    assert.equal(root.querySelectorAll('.dgi-card').length, 1);
  } finally { t.dispose(); }
});

test('预览键盘翻页、归属清理及焦点恢复', async () => {
  const t = setup('<div id="a">' + source('a') + source('b',2) + '</div><div id="b">' + source('c') + '</div>');
  try {
    await t.settle(); const trigger = t.d.querySelector('#a .dgi-preview'); trigger.focus(); trigger.click();
    let dialog = t.d.querySelector('dialog'); assert.ok(dialog.open);
    dialog.dispatchEvent(new t.w.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    assert.match(dialog.querySelector('h2').textContent, /生成的图片 2/);
    t.d.querySelector('#b').remove(); await t.settle(); assert.equal(t.d.querySelector('dialog'), dialog);
    dialog.close(); assert.equal(t.d.activeElement, trigger);
    trigger.click(); t.d.querySelector('#a').innerHTML = '<p>已替换为正文</p>'; await t.settle();
    assert.equal(t.d.querySelector('dialog'), null);
  } finally { t.dispose(); }
});

test('错误可重试，加载成功后显示尺寸；来源路径复制失败可手动选取', async () => {
  const t = setup('<div id="root">' + source('a') + '</div>');
  try {
    await t.settle(); const card = t.d.querySelector('.dgi-card'); const image = card.querySelector('img');
    image.dispatchEvent(new t.w.Event('error'));
    const retry = [...card.querySelectorAll('button')].find((b) => b.textContent === '重新加载');
    assert.equal(retry.hidden, false); retry.click(); assert.match(image.src, /_retry=/);
    Object.defineProperties(image, { naturalWidth: {value: 1200}, naturalHeight: {value: 800} });
    image.dispatchEvent(new t.w.Event('load'));
    assert.equal(retry.hidden, true); assert.match(card.querySelector('.dgi-meta').textContent, /1200 × 800/);
    [...card.querySelectorAll('button')].find((b) => b.textContent === '复制路径').click();
    await Promise.resolve(); assert.equal(card.querySelector('details').open, true);
    assert.match(t.w.getSelection().toString(), /D:\/输出\/a.png/);
  } finally { t.dispose(); }
});

test('无原生dialog时打开原图且仍能完整卸载与重装', async () => {
  const t = setup('<div>' + source('a') + '</div>', { dialog: false });
  try {
    let opened; t.w.open = (...args) => { opened = args; };
    await t.settle(); t.d.querySelector('.dgi-preview').click();
    assert.equal(opened[0], url('a'));
    t.w.__dshGptImagesGallery.dispose();
    assert.equal(t.d.querySelector('[data-dgi-source]'), null);
    assert.equal(t.d.querySelector('.dgi-gallery'), null);
    t.w.eval(galleryScript()); await t.settle();
    assert.equal(t.d.querySelectorAll('.dgi-gallery').length, 1);
  } finally { t.dispose(); }
});

const nativeOptions = { revealEndpoint: 'http://localhost:5000/dsh-gpt-images/reveal', revealToken: 'a'.repeat(64) };
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('打开文件夹替代下载，携带token按POST请求对应图片，防止重复点击', async () => {
  const t = setup('<div>' + source('a') + '</div>', { nativeOptions });
  try {
    const calls = []; let finish;
    t.w.fetch = (endpoint, options) => { calls.push({ endpoint, options }); return new Promise((resolve) => { finish = resolve; }); };
    await t.settle();
    const card = t.d.querySelector('.dgi-card');
    assert.equal(card.querySelector('a[download]'), null);
    assert.doesNotMatch(card.querySelector('.dgi-actions').textContent, /下载/);
    const folder = [...card.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === '打开文件夹');
    assert.equal(folder.disabled, false); folder.click(); folder.click();
    assert.equal(calls.length, 1); assert.equal(folder.disabled, true);
    assert.equal(calls[0].endpoint, 'http://localhost/dsh-gpt-images/reveal');
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].options.headers['x-dsh-gpt-images-token'], nativeOptions.revealToken);
    assert.deepEqual(JSON.parse(calls[0].options.body), { filename: 'generated-' + 'a'.repeat(32) + '.png', path: 'D:/输出/a.png' });
    assert.equal(calls[0].endpoint.includes(nativeOptions.revealToken), false);
    finish({ok:true,json:async()=>({ok:true,location:'primary',selected:true,foreground:true})}); await flush();
    assert.equal(folder.disabled, false); assert.match(t.d.querySelector('.dgi-toast').textContent, /已打开文件夹并选中图片/);
  } finally { t.dispose(); }
});

test('放大预览定位当前图片，缓存回退与失败有明确提示', async () => {
  const t = setup('<div>' + source('a') + source('b',2) + '</div>', { nativeOptions });
  try {
    let body;
    t.w.fetch = async (_url, options) => { body = JSON.parse(options.body); return {ok:true,json:async()=>({ok:true,location:'cache',selected:true,foreground:true})}; };
    await t.settle(); t.d.querySelector('.dgi-preview').click();
    const dialog = t.d.querySelector('dialog');
    dialog.dispatchEvent(new t.w.KeyboardEvent('keydown', {key:'ArrowRight'}));
    const folder = dialog.querySelector('button[aria-label="打开文件夹"]'); folder.click(); await flush();
    assert.equal(body.filename, 'generated-' + 'b'.repeat(32) + '.png');
    assert.match(dialog.querySelector('.dgi-toast').textContent, /缓存图片/);
    assert.doesNotMatch(dialog.querySelector('.dgi-actions').textContent, /下载/);
    t.w.fetch = async () => ({ok:false,json:async()=>({ok:false,message:'文件不可用，请刷新页面'})});
    folder.click(); await flush(); assert.match(dialog.querySelector('.dgi-toast').textContent, /文件不可用/);
  } finally { t.dispose(); }
});

test('缺少token或远程网页时不开放本机文件夹按钮', async () => {
  for (const options of [{}, {nativeOptions, pageURL:'https://example.com/'}]) {
    const t = setup('<div>' + source('a') + '</div>', options);
    try {
      let calls = 0; t.w.fetch = async () => {calls++;}; await t.settle();
      const folder = t.d.querySelector('button[aria-label="打开文件夹"]');
      assert.equal(folder.disabled, true); folder.click(); assert.equal(calls, 0);
    } finally { t.dispose(); }
  }
});

test('卸载时中止未完成的本机定位请求', async () => {
  const t = setup('<div>' + source('a') + '</div>', {nativeOptions});
  try {
    let signal;
    t.w.fetch = (_url, options) => new Promise((_resolve, reject) => { signal = options.signal; signal.addEventListener('abort', () => reject(new Error('aborted')), {once:true}); });
    await t.settle(); t.d.querySelector('button[aria-label="打开文件夹"]').click();
    t.w.__dshGptImagesGallery.dispose(); await flush();
    assert.equal(signal.aborted, true); assert.equal(t.d.querySelector('.dgi-gallery'), null);
  } finally { t.dispose(); }
});

test('系统仅接收请求或窗口仍在后台时不能误报已打开并选中',async()=>{
 const t=setup('<div>'+source('a')+'</div>',{nativeOptions});try{await t.settle();const button=t.d.querySelector('button[aria-label="打开文件夹"]');
 t.w.fetch=async()=>({ok:true,json:async()=>({ok:true,location:'primary',selected:false,foreground:false})});button.click();await flush();assert.doesNotMatch(t.d.querySelector('.dgi-toast').textContent,/已在文件夹中选中|已打开文件夹并选中/);assert.match(t.d.querySelector('.dgi-toast').textContent,/未确认|请求/);
 t.w.fetch=async()=>({ok:true,json:async()=>({ok:true,location:'primary',selected:true,foreground:false})});button.click();await flush();assert.match(t.d.querySelector('.dgi-toast').textContent,/后台|任务栏/);assert.doesNotMatch(t.d.querySelector('.dgi-toast').textContent,/已打开文件夹并选中/);
 }finally{t.dispose();}
});
