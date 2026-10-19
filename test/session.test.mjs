import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
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

test('会话目录不可知且没有 outputDir 时返回 undefined', () => {
  const ctx = fakeCtx({});
  assert.equal(outputDirectoryFor(ctx, { outputDir: '', subdirectory: '' }, { sessionId: 'missing' }), undefined);
});
