# dsh-gpt-images

把 **模型已经返回的生图结果** 自动保存到会话的当前目录，并直接在会话里显示出来。

它不提供新的生图模型，不需要再填一份 API Key，也不会额外发起一次生图请求——
只是补齐 dsh 在“图片已生成、但图片既没进会话、也没落盘”这一段的缺口。

## 解决的问题

用能生图的模型（例如 `gpt-image-*` 这类走 OpenAI Responses / Images API 的模型，
或任何在响应里返回 `b64_json` / `image_url` / `inlineData` 的网关）时：

1. 模型响应里其实已经带了图片；
2. 但聊天适配器只取文本，图片被丢掉 → 会话里看不到；
3. 也没有任何文件写到当前目录 → 用户拿不到图。

装上本插件后，同一轮回复的末尾会出现：

- 图片预览（直接在当前会话里渲染）；
- 「下载原图」链接；
- 图片在本机上的完整路径（默认就是**会话当前目录**）。

## 工作方式

1. 在 `llm/stream` 的单次模型调用作用域内旁路观察 HTTP JSON / SSE 响应，
   在聊天适配器丢弃图片字段之前把它们提取出来；
2. 把 PNG / JPEG / WebP / GIF **原始字节**保存到本机：
   - 主副本：会话当前目录（`generated-<32位随机标识>.<扩展名>`）；
   - 缓存副本：`DSH_HOME/generated-images`（用于会话内预览，重启后旧会话仍可显示）；
3. 在助手回复末尾追加 Markdown 预览、下载原图链接和本地文件路径；
4. 同一响应内按内容 SHA-256 去重；并发会话通过 `AsyncLocalStorage` 隔离。

### 为什么用 Markdown 图片而不是往助手消息里塞 image 块？

当前 dsh 的聊天适配器在下一轮历史转换时不接受含图片块的助手消息，硬塞会让后续对话报错
（`UNSUPPORTED_CONTENT`）。插件因此使用**绝对 `http(s)` 地址的 Markdown 图片 + 文本块**：
聊天渲染器只接受绝对 http(s) 图片地址（相对地址会被当成工作区文件路径而失效），
会话可以继续提问；追加文本会让过期的 provider `replayState` 失效，下一轮按持久化文本重新序列化。
图片路由刻意不使用 `/api` 前缀：`/api` 受连接鉴权围栏保护，插件前缀会绕过该围栏；
改用独立的 `/dsh-gpt-images` 前缀 + 32 位随机文件名作为 capability 链接。

### 纯图片响应

有些生图模型只返回图片、不返回文本，聊天层会把它翻译成 `EMPTY_RESPONSE` 错误并可能自动重试
（等于重复生图、重复扣费）。插件在**图片确实保存成功**时把这一种情况恢复为正常结束；
保存失败则改成明确的 `IMAGE_OUTPUT_SAVE_FAILED` 错误。鉴权、配额、传输、截断、取消错误
一律保持原样，插件自己从不重试生图。

## 安装

需要已初始化的 dsh profile（本机为 `desktop`）。在插件目录：

```powershell
# 方式一：直接从目录安装（开发调试，改动即时生效）
# 在 DeepSeek Harness 里用插件管理器安装：install_bundle，target 为本目录绝对路径
# 或命令行：
dsh plugin --profile desktop add "D:/plugin/deepseek-harness/plugins/dsh-gpt-images"

# 方式二：打包后安装
npm pack --ignore-scripts
dsh plugin --profile desktop add "D:/plugin/deepseek-harness/plugins/dsh-gpt-images/dsh-gpt-images-0.2.0.tgz"
```

安装后重启 / 重载当前 dsh 实例，新会话即可生效。`plugins` 面板或
`Config.listConfigs` 中应出现 `gpt-images` 行。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖（改完重载）：

```yaml
- id: gpt-images
  name: dsh-gpt-images
  config:
    enabled: true
    outputDir: ''            # 留空 = 会话当前目录；也可写绝对路径
    subdirectory: ''         # 在目录下再建一级子目录，留空直接放在当前目录
    cacheDir: ''             # 预览缓存目录，留空 = DSH_HOME/generated-images
    providers: []            # 只处理指定 provider，留空处理全部
    models: []               # 只处理指定 model ID，留空处理全部
    publicBaseURL: ''        # 远程访问时填 Web 根地址，例如 https://dsh.example.com
    maxImageBytes: 20971520  # 单张原图 20 MiB
    maxResponseBytes: 100663296
    maxImages: 20
    downloadRemoteImages: true
    downloadTimeoutMs: 30000
    allowPrivateImageHosts: false  # 仅当本地上游网关返回 localhost 图片 URL 时打开
```

## 支持范围

| 响应形式 | 捕获字段 |
| --- | --- |
| OpenAI Responses | `response.output_item.done` 中已完成的 `image_generation_call.result`（忽略 partial preview）、`response.completed` |
| OpenAI Chat Completions / OpenRouter | `message.images`、`delta.images`、content 里的 `image_url` / `output_image` |
| Gemini | `candidates[].content.parts[].inlineData` / `inline_data` |
| Anthropic Messages | `content[].source` 为 base64 / url 的 image 块 |
| Images API | `data[].b64_json` / `data[].url` |

## 边界与限制

- **只处理已经返回的图片**：不替模型添加 `image_generation` 工具，不强制 `modalities`；
  模型端本身没有生图能力时，需要先配置好上游。
- **只观察当前进程的 `globalThis.fetch`**：WebSocket、子进程、Worker、自带独立 fetch 的 SDK、
  或在插件安装前就缓存了 fetch 引用的适配器不保证能捕获。
- 端点必须是 `/chat/completions`、`/responses`、`/images/generations`、`/images/edits`、
  `/messages` 或 `:generateContent` / `:streamGenerateContent` 结尾的 POST；
  只观察当前会话的模型调用，不观察工具调用、网页请求或后台请求。
- 不扫描普通文本里的 URL / Markdown 图片 / 工具结果，也不恢复插件启用前已经丢掉的旧图片。
- 本地保存是宿主机文件操作，不是智能体 `fs` 工具调用；请确保当前目录可写。
  会话当前目录不可知时，图片只写入插件缓存目录并给出提示，不会误写到应用安装目录。
- 缓存目录没有自动清理策略，请自行管理磁盘空间。

## 安全

- 远程图片默认只允许**不含凭据的公网 HTTPS 443** 地址，逐次做 DNS 解析并固定解析后的 IP，
  拒绝 loopback、私网、链路本地、IPv4 映射与保留地址；不转发模型请求的 Authorization / Cookie。
- 图片格式按文件头识别，不信任文件名或远端 Content-Type。
- 图片只通过 `/dsh-gpt-images/<随机标识>.<扩展名>` 提供，不提供目录列表、任意文件读取；
  只接受 GET/HEAD。该前缀不受 `/api` 连接鉴权围栏保护，因此依赖不可猜测的文件名。
- **图片链接本身是 128 位随机 capability 链接，不是 dsh 会话级鉴权。**
  知道完整链接且能访问你 dsh Web 服务的人可以下载该图；不要把含私密图片的会话公开分享，
  也不要把服务无保护地暴露到公网。

## 开发

```powershell
node --test                 # 26 项离线测试：字段提取 / JSON / SSE / 逐字节分片 / base64 校验 /
                            # 保存目录 / 去重 / SSE 结束 / 取消与失败处理 / cwd 解析
npm run check               # JavaScript 语法检查
npm pack --ignore-scripts   # 打包
```

离线测试不访问外网、不调用真实模型、不产生费用。
