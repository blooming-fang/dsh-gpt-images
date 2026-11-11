import { isAbsolute } from 'node:path';
import { createCapture } from './capture.js';
import { sniffImage } from './extract.js';
import { requestImages, validateImageArgs } from './image-api.js';
import { outputDirectoryAt, resolveSessionCwd } from './session.js';
import { saveImages, imageMarkdown, imagePreviewURL } from './storage.js';

const COMMON = {
  prompt: { type: 'string', description: '完整生成或修改要求。编辑时明确需要保留和改变的内容。' },
  model: { type: 'string', description: '可选图片模型 ID；省略使用插件配置，默认 gpt-image-2.6-flare。不是聊天模型。' },
  size: { type: 'string', description: '静态图片可选尺寸，如 auto 或 1536x1024；GIF不需要size，即使提供也不会向上游发送。' },
  quality: { type: 'string', enum: ['auto', 'low', 'medium', 'high'], description: '可选图片质量。' },
  n: { type: 'integer', description: '生成数量为 1 至 10 的整数，默认 1，且不超过插件 maxImages；多张图片可能产生更多费用。' },
  background: { type: 'string', enum: ['auto', 'opaque', 'transparent'], description: '可选背景模式；模型不支持透明背景时不要指定 transparent。' },
  output_format: { type: 'string', enum: ['png', 'jpeg', 'webp', 'gif'], description: '可选输出格式；生成GIF动画时指定gif。省略时采用上游默认值。' },
  frame_count: { type: 'integer', description: '可选GIF动画帧数，必须为正整数，仅在output_format为gif时使用；GIF时省略默认9帧；用户可明确指定其它正整数，具体范围由上游校验。' },
  frame_duration_ms: { type: 'integer', description: '可选GIF每帧持续时间，单位毫秒，必须为正整数，仅在output_format为gif时使用；例如100表示每帧100毫秒。GIF时省略默认200毫秒，用户明确指定的值优先。' },
};
const IMAGE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    filename: { type: 'string' }, mediaType: { type: 'string' }, bytes: { type: 'integer' },
    path: { type: 'string' }, cachePath: { type: 'string' }, url: { type: 'string' },
  }, required: ['filename', 'mediaType', 'bytes'],
};
export const IMAGE_TOOL_OUTPUT = {
  type: 'object', additionalProperties: false,
  properties: {
    model: { type: 'string' }, images: { type: 'array', items: IMAGE_SCHEMA },
    warnings: { type: 'array', items: { type: 'string' } }, markdown: { type: 'string' },
  }, required: ['model', 'images', 'warnings', 'markdown'],
};

function service(ctx, name) { return ctx.get?.(name) ?? ctx[name]; }

/** Do not guess a provider launch directory, or another concurrently running agent. */
async function toolCwd(ctx, exec) {
  const directory = service(ctx, 'workingDirectory');
  if (typeof directory?.ensure === 'function') {
    const cwd = await directory.ensure(exec.agent, exec.signal);
    if (typeof cwd !== 'string' || !cwd || !isAbsolute(cwd)) throw new Error('无法确定当前会话工作目录，尚未请求生图。');
    return cwd;
  }
  const session = exec.agent.session;
  const projections = service(ctx, 'sessionProjections');
  const cwd = projections?.stateOf?.(session, 'workingDirectory') ?? session.header?.cwd;
  if (typeof cwd === 'string' && cwd && isAbsolute(cwd)) return cwd;
  // Only this exact session is eligible for the compatibility lookup.
  const found = resolveSessionCwd({ get: (name) => name === 'sessions' ? { get: () => session } : undefined }, { sessionId: exec.agent.id });
  return typeof found === 'string' && isAbsolute(found) ? found : undefined;
}

function assertPaths(args, config) {
  const paths = args.image_paths;
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > Math.min(config.maxImages, 16) ||
      paths.some((path) => typeof path !== 'string' || !path.trim() || path.includes(String.fromCharCode(0)))) {
    throw new Error('image_paths 必须是 1 至 16 个非空本地图片路径，且不超过 maxImages。');
  }
  if (args.mask_path !== undefined && (typeof args.mask_path !== 'string' || !args.mask_path.trim() || args.mask_path.includes(String.fromCharCode(0)))) {
    throw new Error('mask_path 必须是非空本地 PNG 路径。');
  }
  if ([...paths, ...(args.mask_path === undefined ? [] : [args.mask_path])].some((path) => path.includes('://') || path.startsWith('data:') || path.startsWith('file:'))) {
    throw new Error('编辑工具只接受本地图片路径，不接受 URL 或 data URI。');
  }
}

async function readInput(ctx, exec, path, cwd, limit, mask) {
  const fs = service(ctx, 'fs');
  if (!fs?.resolve || !fs?.stat || !fs?.readBytes) throw new Error('图片编辑需要宿主 fs 二进制读取服务，尚未请求图片接口。');
  if (!isAbsolute(path) && !cwd) throw new Error('会话工作目录未知，请先设置工作目录或使用绝对图片路径。');
  exec.signal?.throwIfAborted();
  const target = await fs.resolve(path, { cwd, signal: exec.signal });
  const info = await fs.stat(target, exec.signal);
  if (!info || info.type !== 'file') throw new Error('参考图片不存在或不是普通文件，尚未请求图片接口。');
  if (info.size > limit) throw new Error('参考图片超过大小限制，尚未请求图片接口。');
  const bytes = Buffer.from(await fs.readBytes(target, exec.signal, limit));
  if (!bytes.length || bytes.length > limit) throw new Error('参考图片为空或超过大小限制，尚未请求图片接口。');
  const type = sniffImage(bytes);
  if (mask && type.mediaType !== 'image/png') throw new Error('mask_path 必须指向 PNG 遮罩图片。');
  exec.signal?.throwIfAborted();
  return { bytes, ...type, filename: (mask ? 'mask.' : 'reference.') + type.ext };
}

/** Two explicit, paid-on-invocation tools; never depend on passive fetch capture. */
export function registerImageTools(ctx, config, services) {
  if (config.imageToolsEnabled === false) return;
  // Check both names before registering either; never overwrite another plugin.
  for (const name of ['generate_image', 'edit_image']) {
    if (ctx.tools.get?.(name)) throw new Error('gpt-images: 工具名 ' + name + ' 已由其他插件注册，请先解决命名冲突。');
  }
  for (const operation of ['generate', 'edit']) {
    const edit = operation === 'edit';
    const parameters = { type: 'object', additionalProperties: false,
      properties: { ...COMMON, ...(edit ? {
        image_paths: { type: 'array', items: { type: 'string' }, description: '1 至 16 个本地参考图片路径，且不超过 maxImages；相对路径按调用会话当前目录解析。可使用前一次工具返回的 path/cachePath。' },
        mask_path: { type: 'string', description: '可选本地 PNG 遮罩路径。透明区域需要编辑；尺寸等要求由上游校验。' },
      } : {}) }, required: edit ? ['prompt', 'image_paths'] : ['prompt'],
    };
    ctx.tools.register({
      name: edit ? 'edit_image' : 'generate_image',
      description: (edit ? 'Edit local reference images using the configured Image API /images/edits, retaining the chat model. ' : 'Generate real images using the configured Image API /images/generations, retaining the chat model. ') +
        'For GIF, omit size; omitted frame_count and frame_duration_ms default to 9 and 200. This tool makes a potentially billable request ONLY when called. Use it when the user requests image creation/editing. Return the result markdown in your final assistant response to show the existing image gallery; paths support further edits. Do not automatically retry errors/timeouts: a request may already have been billed. Credentials and endpoint are plugin settings, never tool arguments.',
      parameters,
      output: { schema: IMAGE_TOOL_OUTPUT, render: (_args, value) => [{ type: 'text', text: value.markdown }] },
      timeoutMs: config.imageTimeoutMs + config.downloadTimeoutMs * Math.min(config.maxImages, 10) + 30000,
      async execute(args, exec) {
        if (!exec.agent?.id || !exec.agent?.session) throw new Error('图片工具必须在明确的会话中调用，尚未请求生图。');
        exec.signal?.throwIfAborted();
        validateImageArgs(operation, args, config);
        for (const [key, schema] of Object.entries(COMMON)) {
          if (args[key] === undefined || (key === 'size' && args.output_format === 'gif')) continue;
          if (schema.type === 'string' && (typeof args[key] !== 'string' || !args[key].trim())) throw new Error(key + ' 必须是非空字符串。');
          if (schema.type === 'integer' && !Number.isInteger(args[key])) throw new Error(key + ' 必须是整数。');
          if (schema.enum && !schema.enum.includes(args[key])) throw new Error(key + ' 不是支持的选项。');
        }
        const allowed = new Set([...Object.keys(COMMON), ...(edit ? ['image_paths', 'mask_path'] : [])]);
        if (Object.keys(args).some((key) => !allowed.has(key))) throw new Error('图片工具参数包含不支持的字段。');
        if (edit) assertPaths(args, config);
        const cwd = await toolCwd(ctx, exec);
        const options = { sessionId: exec.agent.id, signal: exec.signal };
        const images = [];
        let inputBytes = 0;
        if (edit) {
          for (const path of args.image_paths) {
            const remaining = Math.min(config.maxImageBytes, config.maxResponseBytes - inputBytes);
            if (remaining < 1) throw new Error('参考图片总大小超过限制。');
            const image = await readInput(ctx, exec, path, cwd, remaining, false);
            images.push(image); inputBytes += image.bytes.length;
          }
        }
        let mask;
        if (edit && args.mask_path !== undefined) {
          const remaining = Math.min(config.maxImageBytes, config.maxResponseBytes - inputBytes);
          if (remaining < 1) throw new Error('参考图片总大小超过限制。');
          mask = await readInput(ctx, exec, args.mask_path, cwd, remaining, true);
        }
        exec.signal?.throwIfAborted();
        const result = await (services.requestImages ?? requestImages)(operation, args, config, { signal: exec.signal, images, mask });
        exec.signal?.throwIfAborted();
        const capture = createCapture(config);
        capture.images.push(...result.images.slice(0, config.maxImages));
        if (result.images.length > config.maxImages) capture.warn('返回图片超过数量上限，其余图片未保存。');
        const saved = await saveImages(capture, options, config, { ...services, resolveOutputDirectory: () => outputDirectoryAt(config, cwd) });
        if (!saved.length) throw new Error('图片接口已返回，但未能保存任何图片。请检查格式、目录权限、下载策略和大小限制；不要自动重试生图。');
        const baseURL = config.publicBaseURL || services.baseURL?.() || '';
        const presentationConfig = { ...config, embedImagePath: true };
        let markdown = imageMarkdown(saved, presentationConfig, baseURL);
        const warnings = [...capture.warnings];
        if (warnings.length) markdown += String.fromCharCode(10, 10) + '图片处理提示：' + warnings.join(' ');
        return { model: result.model, images: saved.map(({ sha256, ...image }) => {
          const url = image.cachePath ? imagePreviewURL(image, presentationConfig, baseURL) : undefined;
          return { ...image, ...(url ? { url } : {}) };
        }), warnings, markdown };
      },
    });
  }
}
