import z from '@deepseek-ai/schemastery';
import { installFetchBridge } from './capture.js';
import { captureStream, DEFAULTS } from './bridge.js';
import { cacheDirectory, createRecentSet, imageRoute, ROUTE } from './storage.js';
import { outputDirectoryFor } from './session.js';

export const name = 'dsh-gpt-images';
export const inject = ['llm', 'webServer'];

export const Config = z.object({
  enabled: z.boolean().default(DEFAULTS.enabled).description('捕获模型已经返回的图片并保存到会话当前目录；不会额外发起生图请求。'),
  outputDir: z.string().default(DEFAULTS.outputDir).description('图片保存目录；留空保存到会话当前目录（相对路径按当前目录解析）。'),
  subdirectory: z.string().default(DEFAULTS.subdirectory).description('在当前目录下再建一级子目录，留空直接保存在当前目录。'),
  cacheDir: z.string().default(DEFAULTS.cacheDir).description('图片预览缓存目录；留空使用 DSH_HOME/generated-images。'),
  providers: z.array(z.string()).default([]).description('只处理指定 provider（留空处理全部）。'),
  models: z.array(z.string()).default([]).description('只处理指定 model ID（留空处理全部）。'),
  publicBaseURL: z.string().default(DEFAULTS.publicBaseURL).description('远程访问时图片链接使用的 Web 根地址；本机留空自动使用当前 Web 地址。'),
  maxImageBytes: z.natural().min(1).max(200 * 1024 * 1024).default(DEFAULTS.maxImageBytes),
  maxResponseBytes: z.natural().min(1024).max(512 * 1024 * 1024).default(DEFAULTS.maxResponseBytes),
  maxImages: z.natural().min(1).max(100).default(DEFAULTS.maxImages),
  downloadRemoteImages: z.boolean().default(DEFAULTS.downloadRemoteImages).description('下载模型返回的图片 URL（不转发模型请求的 API 密钥）。'),
  downloadTimeoutMs: z.natural().min(1000).max(300000).default(DEFAULTS.downloadTimeoutMs),
  allowPrivateImageHosts: z.boolean().default(DEFAULTS.allowPrivateImageHosts).description('允许从本机/私网地址下载图片；仅在本地上游网关返回 localhost 图片链接时开启。'),
});

function validateBaseURL(value) {
  if (!value) return '';
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('gpt-images: publicBaseURL 必须是 HTTP(S) Web 根地址（可含挂载子路径，但不能含凭据/查询/片段）。');
  }
  return value.endsWith('/') ? value : value + '/';
}

/** 运行时 Web 根地址：优先远程/反向代理地址，再退回本机监听地址；监听未就绪时返回空串。 */
function webBaseURL(ctx) {
  try {
    const advertised = ctx.get('webApp')?.getAdvertisedUrl?.();
    if (typeof advertised === 'string' && advertised) return advertised;
  } catch {
    // webApp 尚未就绪时退回 webServer。
  }
  try {
    return ctx.webServer.getOrigin();
  } catch {
    return '';
  }
}

/**
 * 旧会话里保存的是绝对地址；当本机 Web 端口变化时，只把「本插件生成的 loopback 图片链接」
 * 改写到当前页面源，不改写外部 URL，也不改其他插件的链接。
 */
function repairImageLinks(hostOrigin) {
  const valid = /^\/dsh-gpt-images\/generated-[a-f0-9]{32}\.(png|jpg|webp|gif)$/;
  const targetOrigin = ['http:', 'https:'].includes(location.protocol) ? location.origin : hostOrigin;
  if (!targetOrigin) return;
  function fix(element) {
    const attr = element.tagName === 'IMG' ? 'src' : 'href';
    const raw = element.getAttribute(attr);
    if (!raw || !raw.includes('/dsh-gpt-images/')) return;
    try {
      const old = new URL(raw, location.href);
      if (!valid.test(old.pathname) || !['http:', 'https:'].includes(old.protocol)) return;
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(old.hostname)) return;
      const next = new URL(old.pathname + old.search, targetOrigin).href;
      if (raw !== next) element.setAttribute(attr, next);
    } catch {
      // 无关或非法 URL 保持原样。
    }
  }
  function visit(root) {
    if (root.nodeType !== 1) return;
    if (root.matches('img[src],a[href]')) fix(root);
    for (const node of root.querySelectorAll('img[src],a[href]')) fix(node);
  }
  const start = () => {
    visit(document.documentElement);
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'attributes') fix(record.target);
        else for (const node of record.addedNodes) visit(node);
      }
    }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'href'] });
  };
  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
}

export function apply(ctx, rawConfig = {}) {
  const config = { ...DEFAULTS, ...rawConfig };
  if (!config.enabled) return;
  config.cacheDir = cacheDirectory(config);
  config.publicBaseURL = validateBaseURL(config.publicBaseURL);

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler: imageRoute(config) }),
    'gpt-images: inline image route',
  );

  // 本机地址可能随端口变化：仅在未配置固定 publicBaseURL 时注入页面侧的链接修复脚本。
  if (!config.publicBaseURL) {
    const script = () => '(' + repairImageLinks.toString() + ')(' + JSON.stringify(webBaseURL(ctx) || '') + ');';
    if (typeof ctx.webServer.collectIndexInjections === 'function') {
      ctx.on('webserver/index-inject', (rows) => rows.push({ kind: 'script', text: script(), placement: 'head' }));
    } else {
      ctx.effect(
        () => ctx.webServer.tapIndex((html) => html.replace('</head>', '<script>' + script() + '</script></head>')),
        'gpt-images: local image link repair',
      );
    }
  }

  const recent = createRecentSet();
  const bridge = installFetchBridge();
  ctx.effect(() => () => bridge.dispose(), 'gpt-images: scoped fetch capture');

  ctx.on('llm/stream', (options, next) =>
    captureStream(options, next, bridge, config, {
      resolveOutputDirectory: (callOptions) => outputDirectoryFor(ctx, config, callOptions),
      cacheDirectory: config.cacheDir,
      baseURL: () => config.publicBaseURL || webBaseURL(ctx),
      recent,
    }),
  );
}
