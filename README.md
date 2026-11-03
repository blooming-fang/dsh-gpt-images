# dsh-gpt-images

**解决 DSH 对接 GPT 生图模型后，图片已经生成、却无法在会话中返回显示的问题。** 自动保存模型已经返回的图片到会话当前目录，并提供会话内预览、引用和本机定位。

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
- 「引用」「打开文件夹」和「原图」操作（画廊模式）；
- 图片在本机上的完整路径（默认就是**会话当前目录**）。

## 0.2.6：减少打开文件夹时的重复闪动

- 已打开的目标目录优先复用，不再重复发送打开请求。
- 新窗口由原生接口一次完成打开与选中；确认期间优先只读观察，避免立即追加选中/聚焦引发第二次显示。
- 仅在必要时补一次选中与一次前台激活；已经前台显示时不重复激活，不再自动闪烁任务栏。
- 保留图片选中、可见性验证和最小化恢复；Windows 自身的窗口显示/刷新仍由系统控制。

## 0.2.5：资源管理器可见性与成功判定修复

- Windows 原生调用之后，进一步核实实际文件管理器窗口与精确图片选中状态，不能仅凭系统请求返回成功就报“已选中”。
- 恢复最小化窗口并尝试切到前台；只有确认前台可见且选中后才显示完整成功提示。
- 系统拒绝切前台时明确提示窗口仍在后台；未确认打开时返回失败或未确认提示，不再误报。

## 0.2.4：新版输入框兼容修复

- 按实际 DSH 安装包中的 Lexical 可编辑输入区接入图片引用，修复仅查找旧式 textarea 导致“未找到可用的当前会话输入框”的问题。
- 同时保留旧版 textarea 支持；禁用、只读、多输入区歧义仍不自动猜测。
- 额外校验宿主会话 ID，避免常驻输入节点在切换会话后接收旧图片。

## 0.2.3：引用图片继续修改

每张图及放大预览中都有 **引用** 按钮：

1. 点击要继续修改的那张图的「引用」。
2. 图片作为真实 File 附件进入**同一会话**的输入区，并出现宿主附件缩略图。
3. 输入修改要求，例如“保留主体，把背景改为深蓝色”，再手动发送。

引用不会覆盖草稿、清除其他附件、改写系统剪贴板或自动发送；同图已在附件区时不重复加入，删除附件后可以再次引用。
引用使用原始图片字节而不是文件路径文本。输入框仍沿用宿主自己的附件数量、大小和格式限制，并且需要当前模型支持图片输入及相应修改能力。
读取过程中切换会话、输入框不可用、图片缓存失效或宿主拒绝附件时会给出提示，不会误加到其他会话。
仅在宿主标准会话输入框中工作；只读子会话、找不到或不唯一的输入框不做全局猜测。引用不额外请求模型。

## 打开文件夹

- 图片卡片及放大预览不再显示下载按钮，改为 **打开文件夹**，同时保留原图入口。
- Windows 调用本机资源管理器并选中对应图片；macOS 使用 Finder 定位；Linux 使用默认文件管理器打开所在目录（不保证选中）。
- 优先定位已保存到会话目录的原图；原图缺失或已修改时，在校验缓存后定位缓存副本，并给出明确提示。
- 仅本机页面可用，远程访问会禁用此按钮；旧页面需要重载插件并刷新以获取新的本机操作凭据。
- 后端只接受回环连接、可信来源和当前插件随机凭据，验证图片文件名、签名、大小以及与缓存内容的一致性，不运行任意命令或任意客户端路径。

## 图片结果画廊

- **图文分区**：正文与图片结果用独立标题和分隔区展示，不再把下载链接、长路径混在正文中。
- **多图横向浏览**：同一次输出的图片组成一排，支持触摸/触控板滚动、左右按钮以及列表聚焦后的方向键；单图使用更宽预览。
- **完整预览**：图片等比完整显示、不裁切，点击放大后可用左右键切换、Esc 关闭；关闭后焦点回到原图。
- **清晰操作**：每张图显示序号、加载后的原始尺寸和格式，提供引用到输入框、打开文件夹、原图新窗口打开；保存位置默认折叠，可复制路径。
- **失败可恢复**：加载状态、失败提示和重新加载按钮；剪贴板不可用时展开并选中路径供手动复制。
- **兼容旧会话**：只增强本插件特定 URL 与图片标签，不改普通 Markdown 图片；原 Markdown 节点不移动或删除，复制/导出仍可用。
- **可关闭**：设置 `gallery: false` 恢复普通 Markdown；深浅色跟随宿主主题，尊重减少动画设置。

这是宿主插件直接注入的轻量增强，无外部字体、CDN 或新增生产依赖，不需要重建 DSH 主应用。
更新宿主插件后需要**重载插件或重启 DSH，然后刷新页面**；仅刷新页面不会让已加载的旧宿主代码变成新版。

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

桌面应用管理的 `desktop` profile 可在 **DeepSeek Harness 插件管理器** 中安装/更新。`dsh plugin` 封装命令会拒绝 desktop；手动维护时可先备份依赖配置，再在该 profile 目录直接运行 pnpm 安装本地发布包，且不要与桌面插件管理器并行操作。

下面 CLI 示例仅用于独立的、非桌面管理 profile（例如 `web`）。在插件目录：

```powershell
# 方式一：直接从目录安装（开发调试；修改后需重载宿主插件）
# 在 DeepSeek Harness 里用插件管理器安装：install_bundle，target 为本目录绝对路径
# 或命令行：
dsh plugin --profile web add "D:/plugin/deepseek-harness/plugins/dsh-gpt-images"

# 方式二：打包后安装
npm pack --ignore-scripts
dsh plugin --profile web add "D:/plugin/deepseek-harness/plugins/dsh-gpt-images/dsh-gpt-images-0.2.6.tgz"
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
    gallery: true            # 独立画廊；false 恢复普通 Markdown
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
| Anthropic Messages | 标准 assistant `message.content[].source` 与流式 `content_block_start` image 块 |
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
npm install --ignore-scripts # 开发测试需要 jsdom；生产插件不依赖 jsdom
node --test                 # 离线回归：捕获/保存/下载安全/目录/画廊 DOM/本机定位安全/图片引用与会话隔离
npm run check               # JavaScript 语法检查
npm pack --ignore-scripts   # 打包
```

离线测试仅使用本机 fixture/模拟响应，不访问外网、不调用真实模型、不产生费用。

相同内容在同会话、同目录的短期重试会复用已有文件并重新返回预览；跨会话/跨目录不互相抑制，文件被删除后重新保存。
远程图片下载关闭时给出明确提示；开启私网网关支持时可使用 HTTP，下载超时覆盖整张图片的所有重定向。

画廊 DOM 测试使用 jsdom；它不代替真实浏览器对布局、原生对话框焦点圈和实际主题的视觉验收。
