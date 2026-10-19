import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { request } from 'node:https';
import { sniffImage } from './extract.js';

const blockedV4 = new BlockList();
const blockedV6 = new BlockList();
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
for (const [ip, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blockedV4.addSubnet(ip, prefix, 'ipv4');
for (const [ip, prefix] of [
  ['::', 96], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['100::', 64], ['2001::', 23], ['2001:db8::', 32],
  ['3fff::', 20], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['64:ff9b:1::', 48], ['ff00::', 8],
]) blockedV6.addSubnet(ip, prefix, 'ipv6');

export function isPublicAddress(address) {
  const family = isIP(address);
  return family === 4
    ? !blockedV4.check(address, 'ipv4')
    : family === 6 && globalV6.check(address, 'ipv6') && !blockedV6.check(address, 'ipv6');
}

async function abortableLookup(hostname, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    lookup(hostname, { all: true }).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/**
 * 下载模型返回的公网图片：默认只允许 HTTPS 443 + 公网地址，不转发模型请求的
 * Authorization / Cookie。`allowPrivateImageHosts` 为本地网关场景的显式降级开关。
 */
export async function downloadImage(source, config, redirects = 0) {
  const { maxImageBytes, downloadTimeoutMs, allowPrivateImageHosts = false } = config;
  const signal = AbortSignal.any([...(config.signal ? [config.signal] : []), AbortSignal.timeout(downloadTimeoutMs)]);
  signal.throwIfAborted();
  const url = new URL(source);
  const protocolOk = url.protocol === 'https:' || (allowPrivateImageHosts && url.protocol === 'http:');
  if (!protocolOk || url.username || url.password || (!allowPrivateImageHosts && url.port && url.port !== '443')) {
    throw new Error('远程图片地址不被允许（需要不含凭据的 HTTPS 443 地址）。');
  }
  let pinned;
  if (!allowPrivateImageHosts) {
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await abortableLookup(hostname, signal);
    signal.throwIfAborted();
    if (!addresses.length || addresses.some((item) => !isPublicAddress(item.address))) {
      throw new Error('已阻止远程图片访问本机、私网或保留地址。');
    }
    pinned = addresses[0];
  }
  const result = await new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        signal,
        agent: false,
        headers: { accept: 'image/png,image/jpeg,image/webp,image/gif', 'user-agent': 'dsh-gpt-images/0.2' },
        ...(pinned
          ? {
              lookup: (_host, options, callback) =>
                options.all ? callback(null, [pinned]) : callback(null, pinned.address, pinned.family),
            }
          : {}),
      },
      (res) => {
        res.on('error', reject);
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.destroy();
          resolve({ redirect: res.headers.location });
          return;
        }
        if (res.statusCode !== 200) {
          res.destroy();
          reject(new Error('远程图片下载失败（HTTP ' + res.statusCode + '）。'));
          return;
        }
        if (Number(res.headers['content-length']) > maxImageBytes) {
          res.destroy();
          reject(new Error('远程图片超过大小限制。'));
          return;
        }
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxImageBytes) {
            res.destroy(new Error('远程图片超过大小限制。'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => resolve({ bytes: Buffer.concat(chunks) }));
      },
    );
    const timer = setTimeout(() => req.destroy(new Error('远程图片下载超时。')), downloadTimeoutMs);
    timer.unref();
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject);
    req.end();
  });
  if ('redirect' in result) {
    if (!result.redirect || redirects >= 3) throw new Error('远程图片重定向无效或次数过多。');
    return downloadImage(new URL(result.redirect, url).href, config, redirects + 1);
  }
  return { bytes: result.bytes, ...sniffImage(result.bytes) };
}
