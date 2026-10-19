import { isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';

/** sessionId -> 最近一次解析到的 cwd（进程内缓存，用于手建调用/代理重建后的兜底）。 */
const recentCwd = new Map();

function get(ctx, name) {
  try {
    return ctx.get(name);
  } catch {
    return undefined;
  }
}

function stateCwd(ctx, session) {
  try {
    const recorded = get(ctx, 'sessionProjections')?.stateOf?.(session, 'workingDirectory');
    if (typeof recorded === 'string' && recorded) return recorded;
  } catch {
    // 投影尚未就绪时退回 SessionHeader。
  }
  const headerCwd = session?.header?.cwd;
  return typeof headerCwd === 'string' && headerCwd ? headerCwd : undefined;
}

function initiatorCwd(ctx) {
  try {
    const agent = get(ctx, 'agents')?.currentInitiator?.();
    return agent ? stateCwd(ctx, agent.session) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 解析本次模型调用所属会话的工作目录（同步，不读持久化）。
 * 顺序：sessions.get(sessionId) 的 workingDirectory 投影 → agents.get(sessionId) →
 * 当前 initiator（同一异步驱动链）→ 本进程缓存。
 */
export function resolveSessionCwd(ctx, options) {
  const id = options?.sessionId;
  if (typeof id === 'string' && id) {
    const sessions = get(ctx, 'sessions');
    let session;
    try {
      session = sessions?.get?.(id);
    } catch {
      session = undefined;
    }
    if (!session) {
      const agents = get(ctx, 'agents');
      try {
        session = agents?.get?.(id)?.session;
      } catch {
        session = undefined;
      }
    }
    if (session) {
      const cwd = stateCwd(ctx, session);
      if (cwd) {
        if (recentCwd.size > 500) recentCwd.clear();
        recentCwd.set(id, cwd);
        return cwd;
      }
    }
    return initiatorCwd(ctx) ?? recentCwd.get(id);
  }
  return initiatorCwd(ctx);
}

function expandHome(path) {
  if (path === '~') return homedir();
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2));
  return path;
}

/**
 * 图片主副本目录：配置的 outputDir（绝对路径；相对路径按会话目录解析）优先，
 * 否则就是会话当前目录；subdirectory 追加一级子目录（默认空，即直接落在当前目录）。
 * 返回 undefined 表示目录不可知——此时只保存到插件缓存目录，避免误写到应用目录。
 */
export function outputDirectoryFor(ctx, config, options) {
  const configured = typeof config.outputDir === 'string' && config.outputDir.trim() ? expandHome(config.outputDir.trim()) : '';
  const cwd = resolveSessionCwd(ctx, options);
  if (!configured && !cwd) return undefined;
  const base = configured ? (isAbsolute(configured) ? configured : join(cwd ?? process.cwd(), configured)) : cwd;
  const subdirectory = typeof config.subdirectory === 'string' ? config.subdirectory.trim() : '';
  return subdirectory ? join(base, subdirectory) : base;
}
