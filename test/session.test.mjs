import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { resolveSessionCwd, outputDirectoryFor } from '../src/session.js';

function fakeCtx({ sessions = new Map(), agents = new Map(), projections = new Map(), initiator, defaultDirectory } = {}) {
  const services = {
    sessions: { get: (id) => sessions.get(id) },
    agents: {
      get: (id) => agents.get(id),
      currentInitiator: () => initiator,
    },
    sessionProjections: {
      stateOf: (session, key) => (key === 'workingDirectory' ? projections.get(session.id) : undefined),
    },
    workingDirectory: { defaultDirectory },
  };
  return { get: (name) => services[name] };
}

function session(id, cwd) {
  return { id, header: cwd ? { cwd } : {} };
}

test('优先使用 sessions 服务 + workingDirectory 投影', () => {
  const live = session('s1', 'C:/fallback');
  const ctx = fakeCtx({ sessions: new Map([['s1', live]]), projections: new Map([['s1', 'C:/project']]) });
  assert.equal(resolveSessionCwd(ctx, { sessionId: 's1' }), 'C:/project');
});

test('没有投影时回退到 SessionHeader.cwd', () => {
  const ctx = fakeCtx({ sessions: new Map([['s1', session('s1', 'C:/header')]]) });
  assert.equal(resolveSessionCwd(ctx, { sessionId: 's1' }), 'C:/header');
});

test('sessions 不可用时回退 agents.get(sessionId).session', () => {
  const ctx = fakeCtx({ agents: new Map([['s1', { session: session('s1', 'C:/agent') }]]) });
  assert.equal(resolveSessionCwd(ctx, { sessionId: 's1' }), 'C:/agent');
});

test('都没有时回退当前 initiator，而不是 defaultDirectory', () => {
  const ctx = fakeCtx({ initiator: { session: session('s1', 'C:/initiator') }, defaultDirectory: 'C:/app-dir' });
  assert.equal(resolveSessionCwd(ctx, { sessionId: 's1' }), 'C:/initiator');
});

test('完全无法解析时返回 undefined', () => {
  const ctx = fakeCtx({ defaultDirectory: 'C:/app-dir' });
  assert.equal(resolveSessionCwd(ctx, { sessionId: 'missing' }), undefined);
});

test('outputDir 显式配置优先；相对路径按会话目录解析', () => {
  const ctx = fakeCtx({ initiator: { session: session('s1', 'C:/project') } });
  assert.equal(outputDirectoryFor(ctx, { outputDir: 'D:/AI/images', subdirectory: '' }, {}), 'D:/AI/images');
  assert.equal(outputDirectoryFor(ctx, { outputDir: 'shots', subdirectory: '' }, {}), join('C:/project', 'shots'));
  assert.equal(outputDirectoryFor(ctx, { outputDir: '', subdirectory: 'gen' }, {}), join('C:/project', 'gen'));
});

test('会话 cwd 未知时相对 outputDir 不退回宿主进程或默认目录', () => {
  const ctx = fakeCtx({ defaultDirectory: join(homedir(), 'host-app') });
  for (const outputDir of ['shots', './shots', '.', '..', '  shots  ']) {
    for (const subdirectory of ['', 'generated']) {
      assert.equal(outputDirectoryFor(ctx, { outputDir, subdirectory }, { sessionId: 'unknown-relative-output' }), undefined);
    }
  }
});

test('会话 cwd 未知时显式绝对路径与 home 路径仍可用', () => {
  const ctx = fakeCtx({});
  const absolute = join(homedir(), 'images');
  assert.equal(outputDirectoryFor(ctx, { outputDir: absolute, subdirectory: '' }, {}), absolute);
  assert.equal(outputDirectoryFor(ctx, { outputDir: '  ' + absolute + '  ', subdirectory: ' generated ' }, {}), join(absolute, 'generated'));
  assert.equal(outputDirectoryFor(ctx, { outputDir: '~', subdirectory: '' }, {}), homedir());
  assert.equal(outputDirectoryFor(ctx, { outputDir: '~/images', subdirectory: 'generated' }, {}), join(absolute, 'generated'));
});

test('相对 outputDir 在已知会话 cwd 下仍按会话目录解析并追加子目录', () => {
  const cwd = join(homedir(), 'session-project');
  const ctx = fakeCtx({ sessions: new Map([['relative-output', session('relative-output', cwd)]]) });
  assert.equal(outputDirectoryFor(ctx, { outputDir: './shots', subdirectory: 'generated' }, { sessionId: 'relative-output' }), join(cwd, 'shots', 'generated'));
});

test('会话目录不可知且没有 outputDir 时返回 undefined', () => {
  const ctx = fakeCtx({});
  assert.equal(outputDirectoryFor(ctx, { outputDir: '', subdirectory: '' }, { sessionId: 'missing' }), undefined);
});
