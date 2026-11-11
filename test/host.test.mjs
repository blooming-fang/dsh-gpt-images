import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

// Normal development resolves npm-installed dependencies. This optional override
// reuses the desktop profile's existing dependency for fully offline workspace QA.
let hook;
if (process.env.DSH_TEST_DEPENDENCY_ROOT) {
  const require = createRequire(resolve(process.env.DSH_TEST_DEPENDENCY_ROOT, 'package.json'));
  // Resolve before registering: recent Node versions apply these hooks to CJS
  // require.resolve too, so resolving inside the hook would recurse forever.
  const schemaURL = pathToFileURL(require.resolve('@deepseek-ai/schemastery')).href;
  hook = registerHooks({ resolve(specifier, context, next) {
    return next(specifier === '@deepseek-ai/schemastery' ? schemaURL : specifier, context);
  } });
}
const { apply } = await import('../src/index.js');
hook?.deregister();

function host(modern = false) {
  const events = new Map(); const effects = []; const routes = []; const taps = [];
  const webServer = {
    getOrigin: () => 'http://127.0.0.1:5000',
    register(route) { routes.push(route); return () => routes.splice(routes.indexOf(route), 1); },
    tapIndex(tap) { taps.push(tap); return () => taps.splice(taps.indexOf(tap), 1); },
  };
  if (modern) webServer.collectIndexInjections = () => [];
  const ctx = {
    webServer, get: () => undefined,
    effect(effect) { effects.push(effect()); },
    on(name, handler) { events.set(name, handler); },
  };
  return { ctx, events, routes, taps, async dispose() { for (const effect of effects.reverse()) await effect?.(); } };
}

test('旧宿主tapIndex注入可解析的画廊与端口修复脚本，卸载恢复fetch', async () => {
  const h = host(); const fetch = globalThis.fetch;
  try {
    apply(h.ctx);
    assert.equal(h.routes[0].path, '/dsh-gpt-images');
    assert.ok(h.events.has('llm/stream'));
    assert.equal(h.taps.length, 1);
    const html = h.taps[0]('<html><head></head><body></body></html>');
    assert.match(html, /installImageGallery/); assert.match(html, /repairImageLinks/);
    const script = html.slice(html.indexOf('<script>') + 8, html.indexOf('</script>'));
    assert.doesNotThrow(() => new vm.Script(script));
    assert.notEqual(globalThis.fetch, fetch);
  } finally { await h.dispose(); }
  assert.equal(globalThis.fetch, fetch); assert.equal(h.routes.length, 0);
});

test('新宿主使用index-inject注册，固定公网根地址仍启用画廊且不重写链接', async () => {
  const h = host(true);
  try {
    apply(h.ctx, { publicBaseURL: 'https://example.com/dsh' });
    assert.equal(h.taps.length, 0);
    const rows = []; h.events.get('webserver/index-inject')(rows);
    assert.equal(rows.length, 1); assert.equal(rows[0].kind, 'script'); assert.equal(rows[0].placement, 'head');
    assert.match(rows[0].text, /installImageGallery/); assert.doesNotMatch(rows[0].text, /repairImageLinks/);
    assert.doesNotThrow(() => new vm.Script(rows[0].text));
  } finally { await h.dispose(); }
});

test('关闭画廊保留本地端口修复；固定根地址时不注入任何增强脚本', async () => {
  for (const publicBaseURL of ['', 'https://example.com']) {
    const h = host();
    try {
      apply(h.ctx, { gallery: false, publicBaseURL });
      if (publicBaseURL) assert.equal(h.taps.length, 0);
      else {
        const html = h.taps[0]('<head></head>');
        assert.match(html, /repairImageLinks/); assert.doesNotMatch(html, /installImageGallery/);
      }
      assert.equal(h.routes.length, 1); assert.ok(h.events.has('llm/stream'));
    } finally { await h.dispose(); }
  }
});

test('禁用插件不改fetch、不注册路由、事件或注入', async () => {
  const h = host(); const fetch = globalThis.fetch;
  apply(h.ctx, { enabled: false });
  assert.equal(h.routes.length, 0); assert.equal(h.events.size, 0); assert.equal(h.taps.length, 0);
  assert.equal(globalThis.fetch, fetch); await h.dispose();
});

test('非法公网根地址在注册任何资源前明确拒绝', () => {
  for (const publicBaseURL of ['javascript:alert(1)', 'https://user:pass@example.com', 'https://example.com/?token=x']) {
    const h = host(); assert.throws(() => apply(h.ctx, { publicBaseURL }));
    assert.equal(h.routes.length, 0); assert.equal(h.events.size, 0);
  }
});

test('本机操作凭据仅随索引注入，每次插件实例独立生成且不进入图片URL', async () => {
  const tokens = [];
  for (let i = 0; i < 2; i++) {
    const h = host();
    try {
      apply(h.ctx);
      const html = h.taps[0]('<head></head>');
      const match = /"revealToken":"([a-f0-9]{64})"/.exec(html);
      assert.ok(match); tokens.push(match[1]);
      assert.match(html, /"revealEndpoint":"http:\/\/127[.]0[.]0[.]1:5000\/dsh-gpt-images\/reveal"/);
      assert.equal(h.routes[0].path.includes(match[1]), false);
      assert.equal(h.taps[0]('<head></head>').includes(match[1]), true);
      let status; let body;
      const req = { url:'/dsh-gpt-images/reveal', method:'GET', headers:{origin:'http://127.0.0.1:5000'}, socket:{remoteAddress:'127.0.0.1'} };
      const res = { writeHead(code) { status=code; }, end(value) { body=value; } };
      await h.routes[0].handler(req,res);
      assert.notEqual(status,200); assert.ok(body);
    } finally { await h.dispose(); }
  }
  assert.notEqual(tokens[0], tokens[1]);
});


function toolHost() {
  const h = host(true); const definitions = new Map();
  const tools = {
    get: (name) => definitions.get(name),
    register(definition) {
      definitions.set(definition.name, definition);
      h.ctx.effect(() => () => definitions.delete(definition.name));
    },
  };
  h.ctx.inject = (required, callback) => {
    assert.deepEqual(required, ['tools']);
    callback({ ...h.ctx, tools });
  };
  return { ...h, definitions };
}

test('新宿主同时注册两个图片工具与原捕获/画廊，卸载时全部释放', async () => {
  const h = toolHost(); const before = globalThis.fetch;
  try {
    apply(h.ctx, { imageApiBaseURL: 'http://localhost:8317', imageApiKey: 'fixture-do-not-inject' });
    assert.deepEqual([...h.definitions.keys()], ['generate_image', 'edit_image']);
    assert.ok(h.events.has('llm/stream')); assert.equal(h.routes.length, 1);
    const rows = []; h.events.get('webserver/index-inject')(rows);
    assert.match(rows[0].text, /installImageGallery/);
    assert.equal(rows[0].text.includes('fixture-do-not-inject'), false);
    for (const definition of h.definitions.values()) {
      assert.equal(JSON.stringify(definition.parameters).includes('fixture-do-not-inject'), false);
      assert.ok(definition.output.schema); assert.equal(typeof definition.output.render, 'function');
    }
  } finally { await h.dispose(); }
  assert.equal(h.definitions.size, 0); assert.equal(h.routes.length, 0); assert.equal(globalThis.fetch, before);
});

test('只关闭主动图片工具不影响旧捕获；关闭画廊不影响主动工具', async () => {
  const disabledTools = toolHost();
  try {
    apply(disabledTools.ctx, { imageToolsEnabled: false });
    assert.equal(disabledTools.definitions.size, 0);
    assert.equal(disabledTools.routes.length, 1); assert.ok(disabledTools.events.has('llm/stream'));
    const rows = []; disabledTools.events.get('webserver/index-inject')(rows); assert.match(rows[0].text, /installImageGallery/);
  } finally { await disabledTools.dispose(); }
  const noGallery = toolHost();
  try {
    apply(noGallery.ctx, { gallery: false });
    assert.equal(noGallery.definitions.size, 2); assert.ok(noGallery.events.has('llm/stream'));
    const rows = []; noGallery.events.get('webserver/index-inject')(rows);
    assert.doesNotMatch(rows[0].text, /installImageGallery/); assert.match(rows[0].text, /repairImageLinks/);
  } finally { await noGallery.dispose(); }
});

test('彻底禁用插件时不注册新工具，重载不会残留重复工具', async () => {
  const off = toolHost(); apply(off.ctx, { enabled: false });
  assert.equal(off.definitions.size, 0); await off.dispose();
  for (let i = 0; i < 2; i++) {
    const h = toolHost(); apply(h.ctx); assert.equal(h.definitions.size, 2); await h.dispose(); assert.equal(h.definitions.size, 0);
  }
});
