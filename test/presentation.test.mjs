import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { galleryScript } from '../src/presentation.js';

test('画廊注入为自包含且可解析的脚本，不含结束script标签', () => {
  const script = galleryScript();
  assert.ok(script.includes('installImageGallery'));
  assert.doesNotMatch(script, /<\/script/i);
  assert.doesNotThrow(() => new vm.Script(script));
});

test('页面尚未ready时延迟挂载，重装/卸载均清理style与事件', () => {
  const styles = [];
  const events = [];
  const context = vm.createContext({
    window: {}, AbortController,
    document: {
      body: null,
      head: { append(node) { styles.push(node); } },
      createElement() { const node = { dataset: {}, remove() { styles.splice(styles.indexOf(node), 1); } }; return node; },
      addEventListener(...args) { events.push(args); },
    },
  });
  const script = galleryScript();
  vm.runInContext(script, context);
  assert.equal(styles.length, 1);
  assert.equal(events[0][0], 'DOMContentLoaded');
  assert.equal(events[0][2].once, true);
  vm.runInContext(script, context);
  assert.equal(styles.length, 1);
  assert.equal(events[0][2].signal.aborted, true);
  context.window.__dshGptImagesGallery.dispose();
  assert.equal(styles.length, 0);
  assert.equal(context.window.__dshGptImagesGallery, undefined);
});
