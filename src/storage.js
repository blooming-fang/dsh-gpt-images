import { copyFile, link, mkdir, open, rename, unlink } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { decodeImage } from './extract.js';
import { downloadImage } from './download.js';

export const ROUTE = '/dsh-gpt-images';
export const FILE_NAME = /^generated-[a-f0-9]{32}\.(png|jpg|webp|gif)$/;
const MEDIA = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

/** 插件自己的隐藏缓存目录（也是图片 URL 的实际来源），默认在 DSH_HOME 下。 */
export function cacheDirectory(config) {
  return resolve(config.cacheDir || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'generated-images'));
}

async function makeDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
}

async function atomicWrite(path, bytes) {
  const temp = path + '.' + randomBytes(8).toString('hex') + '.tmp';
  let file;
  try {
    file = await open(temp, 'wx', 0o600);
    await file.writeFile(bytes);
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temp, path);
  } catch (error) {
    await file?.close().catch(() => {});
    await unlink(temp).catch(() => {});
    throw error;
  }
}

/** 同内容图片在短时间窗口内只保存一次（覆盖重试/重放导致的重复响应）。 */
export function createRecentSet(ttlMs = 10 * 60 * 1000, limit = 200) {
  const entries = new Map();
  const now = () => Date.now();
  return {
    has(hash) {
      const at = entries.get(hash);
      if (at === undefined) return false;
      if (now() - at > ttlMs) {
        entries.delete(hash);
        return false;
      }
      return true;
    },
    add(hash) {
      entries.set(hash, now());
      if (entries.size > limit) entries.delete(entries.keys().next().value);
    },
  };
}

/**
 * 保存一组已捕获的图片。
 * 主副本写入“会话当前目录”（用户要的交付物），缓存副本写入插件缓存目录（图片 URL 的来源）。
 * 任一写入失败都只降级并给出提示，不阻断主流程。
 */
export async function saveImages(capture, options, config, services) {
  const results = [];
  const savedHashes = new Set();
  let primaryDirectory;
  try {
    primaryDirectory = await services.resolveOutputDirectory(options);
  } catch {
    capture.warn('无法确定会话当前目录，图片只保存到插件缓存目录。');
  }
  if (!primaryDirectory) capture.warn('无法确定会话当前目录，图片只保存到插件缓存目录。');
  const cacheDir = services.cacheDirectory;
  for (const candidate of capture.images) {
    options.signal?.throwIfAborted();
    let image;
    try {
      image = candidate.url
        ? await downloadImage(candidate.url, { ...config, signal: options.signal })
        : decodeImage(candidate, config.maxImageBytes);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      // 远端 URL 与任意错误文本都可能带密钥：只给有界、通用提示。
      capture.warn(candidate.url ? '一张远程图片下载或保存失败，请检查地址、网络和保存目录。' : '一张图片解码或保存失败，请检查格式、大小限制和保存目录。');
      continue;
    }
    options.signal?.throwIfAborted();
    const digest = createHash('sha256').update(image.bytes).digest('hex');
    if (savedHashes.has(digest) || services.recent.has(digest)) continue;
    savedHashes.add(digest);

    const filename = 'generated-' + randomBytes(16).toString('hex') + '.' + image.ext;
    const result = { filename, mediaType: image.mediaType, bytes: image.bytes.length, sha256: digest };

    // 缓存副本：URL 从这里读取，重启后旧会话里的图片仍然可显示。
    try {
      await makeDirectory(cacheDir);
      const cachePath = join(cacheDir, filename);
      await atomicWrite(cachePath, image.bytes);
      result.cachePath = cachePath;
    } catch {
      capture.warn('图片已生成，但插件缓存写入失败，会话里可能无法预览。');
    }

    // 主副本：会话当前目录。
    if (primaryDirectory) {
      try {
        await makeDirectory(primaryDirectory);
        const path = join(primaryDirectory, filename);
        if (resolve(primaryDirectory) === resolve(cacheDir)) {
          result.path = result.cachePath;
        } else {
          await atomicWrite(path, image.bytes);
          result.path = path;
        }
      } catch {
        capture.warn('图片无法写入会话当前目录，已仅保存在插件缓存目录。');
      }
    }
    if (!result.cachePath && !result.path) {
      capture.warn('图片保存失败，未写入任何位置。');
      continue;
    }
    services.recent.add(digest);
    results.push(result);
  }
  return results;
}

function displayPath(path) {
  return String(path).replaceAll('\\', '/');
}

/**
 * 生成助手回复末尾的图片预览 + 下载 + 本地文件说明。
 * 聊天渲染器只接受绝对 http(s) 图片地址，因此这里必须用运行时的 Web 根地址；
 * baseURL 为空时降级为纯本地路径说明（不渲染坏图）。
 */
export function imageMarkdown(results, config, baseURL) {
  const base = config.publicBaseURL || baseURL || '';
  const absolute = (filename, suffix = '') => {
    if (!base) return '';
    const root = base.endsWith('/') ? base : base + '/';
    return new URL(ROUTE.slice(1) + '/' + filename + suffix, root).href;
  };
  return results
    .map((image, index) => {
      const label = '生成的图片 ' + (index + 1);
      const url = absolute(image.filename);
      const lines = [];
      if (image.cachePath && url) {
        lines.push('![' + label + '](<' + url + '>)');
        lines.push('[下载原图](<' + absolute(image.filename, '?download=1') + '>) · 已保存到 `' + displayPath(image.path ?? image.cachePath) + '`');
      } else {
        lines.push(label + (image.cachePath ? '（预览地址不可用）' : '（预览不可用）'));
        if (image.path) lines.push('已保存到 `' + displayPath(image.path) + '`');
        else if (image.cachePath) lines.push('已保存到 `' + displayPath(image.cachePath) + '`');
      }
      return lines.join('\n\n');
    })
    .join('\n\n');
}

/** 只按不可猜测的文件名提供缓存目录里的图片，不暴露任意路径或目录列表。 */
export function imageRoute(config) {
  const directory = cacheDirectory(config);
  return async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' });
      res.end();
      return;
    }
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    const filename = url.pathname.slice(ROUTE.length + 1);
    if (!FILE_NAME.test(filename)) {
      res.writeHead(404);
      res.end();
      return;
    }
    let file;
    try {
      file = await open(join(directory, filename), 'r');
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > config.maxImageBytes) {
        res.writeHead(404);
        res.end();
        return;
      }
      const ext = filename.split('.').pop();
      res.writeHead(200, {
        'content-type': MEDIA[ext],
        'content-length': stat.size,
        'content-disposition': (url.searchParams.get('download') === '1' ? 'attachment' : 'inline') + '; filename="' + filename + '"',
        'x-content-type-options': 'nosniff',
        'cache-control': 'private, max-age=86400',
        'referrer-policy': 'no-referrer',
        'content-security-policy': "default-src 'none'; sandbox",
      });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      const stream = file.createReadStream({ autoClose: false });
      await new Promise((resolvePromise, reject) => {
        const finish = () => {
          stream.destroy();
          resolvePromise();
        };
        res.once('finish', finish);
        res.once('close', finish);
        stream.once('error', reject);
        stream.pipe(res);
      });
    } catch {
      if (!res.headersSent) res.writeHead(404);
      res.end();
    } finally {
      await file?.close().catch(() => {});
    }
  };
}
