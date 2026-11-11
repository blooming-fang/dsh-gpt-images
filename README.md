# dsh-gpt-images

**解决 DSH 对接 GPT 生图模型后，图片已经生成、却无法在会话中返回显示的问题。** 自动保存模型已经返回的图片到会话当前目录，并提供会话内预览、引用和本机定位。

原有的**被动捕获模式**不提供新的生图模型、不需要另填 API Key，也不会额外发起生图请求，只补齐“图片已生成、但图片既没进会话、也没落盘”的缺口。

**0.3.0 新增独立工具模式**：保留当前聊天模型，通过 `generate_image` / `edit_image` 主动调用 OpenAI 兼容 Images API；默认接入本地服务 `http://localhost:8317`。只有调用工具时才会发送可能计费的图片请求，需单独配置图片服务鉴权。两种模式可以同时使用。

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

## 0.3.3：GIF 默认帧参数与尺寸规则

两个工具显式指定 `output_format: gif` 时，都会执行以下规则：

- 未指定 `frame_count` 时，固定补为 `9` 并发送到上游。
- 未指定 `frame_duration_ms` 时，固定补为 `200` 毫秒并发送到上游。
- 用户明确指定的正整数优先，只为缺失的字段补默认值；显式非法值仍会报错，不会被默认值掩盖。
- GIF 请求始终不包含 `size`，即使调用方传入该字段也会忽略。
- 生成接口为 JSON 数字，编辑接口为 multipart 字段。静态图的 `size` 规则不变，不会添加 GIF 帧参数。
- 因此仅说“生成 GIF”时，默认单轮为 9 帧 × 200 毫秒，即 1.8 秒。无需修改 profile 的全局配置。

## 0.3.2：GIF 动画与帧参数

`generate_image` 和 `edit_image` 均支持用户指定：

```json
{
  "prompt": "生成海边海浪轻轻起伏的循环动画",
  "output_format": "gif",
  "frame_count": 8,
  "frame_duration_ms": 100
}
```

- 生成接口将帧参数作为 JSON 数字发送；编辑接口将其作为 multipart 表单字段发送，同时上传参考图原始字节。
- frame_count 为帧数，frame_duration_ms 为每帧毫秒数，均为可选正整数；提供帧参数时必须显式设置 output_format: gif，不会悄悄把 PNG/JPEG/WebP 改成 GIF。
- 可以只指定 GIF 格式，或只指定一个帧参数；从 0.3.3 起，缺失字段按帧数 9、每帧 200 毫秒补齐，GIF 不发送 size。具体支持的帧数、时长及模型限制仍由本地转发服务和上游校验，插件不假设未证实的范围。
- 示例为 8 帧 × 100 毫秒，即单轮总时长 0.8 秒。直接在会话中说“生成 GIF，8 帧，每帧 100 毫秒”，聊天模型即可传入这些工具参数，不需要修改 profile 的全局配置。
- 返回的 GIF 原始字节直接保存为 .gif 并通过原有画廊展示，不转码、不提取首帧；参考 GIF 也按原始字节上传。实际是否输出动画及上游是否保留动画由图片服务决定。
- 保留 0.3.1 画廊修复、原有静态图功能、鉴权、取消、大小限制及不自动重试策略。更新后重载插件或重启 DSH，再刷新页面使新的工具参数声明生效。

## 0.3.1：恢复模型改写回复后的图片画廊

- 画廊按本插件专用图片 URL 及随机文件名识别，不再要求固定的“生成的图片 1”标签；助手改写图片标题、alt 或下载链接文字后仍显示引用、打开文件夹和原图操作。普通外部图片不增强。
- 工具返回的图片 URL 附带编码后的 `dgi_path` 保存位置提示，即使助手省略相邻的固定路径段落，画廊仍能展示实际完整路径。这个字段只是显示提示，不赋予任意文件读取/定位权限；后端仍按原规则校验图片名、缓存内容和目标文件。图片链接现在也可能包含本机保存路径，请勿公开分享含私密路径或图片的链接。
- 对旧会话中没有保存位置提示的图片，能从原 Markdown 恢复路径时使用原路径；否则明确显示“缓存副本”的完整位置，不冒充会话目录中的原图。
- 更新后需重载插件或重启 DSH，再刷新页面；已生成的图片不需要重新请求模型。

## 0.3.0：独立生图 / 编辑工具

无需把聊天模型换成图片模型，也不依赖 Responses 的内置 image_generation 支持：

| 工具 | 调用端点 | 用途 |
| --- | --- | --- |
| `generate_image` | POST /v1/images/generations | 提示词生成图片，JSON 请求 |
| `edit_image` | POST /v1/images/edits | 本地参考图 + 修改要求，multipart 请求，可选 PNG 遮罩 |

保留原有图片捕获、画廊、引用、原图、本机定位和缓存功能；工具直接保存结果，不依赖原先只观察模型调用的 fetch 捕获器。默认图片模型为 `gpt-image-2.6-flare`，也可在插件配置或单次工具参数中选择服务实际提供的模型。

### 配置本地图片服务

在插件管理器的 gpt-images 配置中设置以下字段（其余已有配置保持不变）：

```yaml
imageToolsEnabled: true
imageApiBaseURL: 'http://localhost:8317'
imageApiKey: ''                  # 在本机插件设置的密钥字段填写，不要在会话中发送真实密钥
imageApiKeyEnv: 'DSH_IMAGE_API_KEY'
imageModel: 'gpt-image-2.6-flare'
imageTimeoutMs: 300000
```

- 根地址自动追加 /v1，所以上述地址最终请求 /v1/images/generations 或 /v1/images/edits。填 http://localhost:8317/v1 也可，不会重复 /v1；有自定义挂载路径时，将其视为完整 API 前缀。
- imageApiBaseURL 是上游图片接口地址；publicBaseURL 是 DSH 图片预览地址，**不要混填**。
- imageApiKey 优先于 imageApiKeyEnv 指定的宿主进程环境变量；空值不发送 Authorization。不会自动读取聊天模型的 Key。当前本地服务无鉴权访问模型列表返回 401，需要填写有效凭据。
- 密钥配置标记为 secret，不会放入工具参数、结果、画廊脚本或上游报错文本。建议使用插件管理器密钥字段或环境变量，不提交含密钥的配置。
- 环境变量必须由运行 DSH 的进程继承；在另一终端设置变量不会改变已经运行的桌面应用，修改后可能需要完整退出并重新启动。
- imageToolsEnabled: false 只关闭这两个主动工具；原有捕获和画廊仍保留。enabled: false 关闭整个插件。
- 新工具不受原有 providers / models 白名单过滤；那些过滤器仍只控制被动捕获。

### 使用方法

更新插件并重载/重启 DSH 后刷新页面，在会话中直接请求“帮我生成一张产品海报”。模型应调用 generate_image，再把返回的 markdown 放入最终回复，已有画廊会自动增强图片预览。

工具参数示例（这是工具 SDK 参数，不是必须手动发送的 HTTP 请求）：

```json
{
  "prompt": "生成一张深蓝色工业产品海报，突出精密传感器，不要文字",
  "model": "gpt-image-2.6-flare",
  "size": "1536x1024",
  "quality": "medium",
  "n": 1
}
```

继续修改时调用 edit_image，用上一次结果中的 path 或 cachePath 指定实际参考图：

```json
{
  "prompt": "保留产品主体和构图，只把背景改成浅灰色",
  "image_paths": ["D:/your-workspace/generated-实际随机标识.png"]
}
```

- 两个工具均支持 prompt，以及可选 model、size、quality、n、background、output_format、frame_count、frame_duration_ms。默认使用配置的图片模型和 n: 1；显式 GIF 另有帧数 9、每帧 200 毫秒的缺省值且不发送 size，其余可选字段不填就不发送。静态图的尺寸、质量和透明背景由服务端决定。输出格式支持 png/jpeg/webp/gif，不支持 SVG；两个帧参数仅用于显式指定的 GIF。
- edit_image 额外需要 image_paths 数组，可附 mask_path（PNG）。相对路径按**调用会话当前工作目录**解析，优先使用新版宿主 workingDirectory.ensure；不使用应用安装目录，也不猜测其他会话。
- 参考图通过宿主 fs.resolve/stat/readBytes 读取，限制单图和总字节数，不直接使用 Node 文件读取绕过宿主 fs 服务。cwd 只是路径基准，不代表读取范围限制；请仅选择用户要求编辑的图片。未落为本地文件的附件不能直接用附件 ID 代替路径。
- 编辑使用原图真实字节，遮罩透明度和尺寸等由上游验证。多轮编辑每次明确传参考图和完整修改要求；Images API 不自动继承 Responses 会话上下文。
- 工具返回 images（含 path/cachePath、可用时的 url）、markdown 和 warnings。主副本不可写时可能仅保存到缓存；没有任何副本保存成功则明确失败，不能误报已生成。
- 工具输出复用已有插件的宿主侧保存机制，不是通用 fs.write 工具调用；保存目录由插件配置与会话工作目录决定，不允许工具参数任意指定输出位置。
- 默认 5 分钟接口超时；取消传递至请求和参考图读取。**不自动重试**：超时或断线不意味着上游未生成/未计费。
- 不更改普通聊天的 Responses/Chat Completions 路由，也不向原聊天请求额外注入 image_generation 工具。原有工具能否可见还取决于当前会话的工具允许列表；Code Mode 下从 run_code 内调用 tools.generate_image / tools.edit_image。

### 网络与安全边界

图片接口只使用配置中的 URL 和凭据，模型参数不能提供自定义地址、请求头或 Key。远程 API 必须为 HTTPS，仅回环地址允许 HTTP；拒绝接口重定向，防止凭据被转发。响应大小、单图大小与图片数量有上限；失败提示不回显上游可能含密钥的响应正文。

上游返回 b64_json 时直接解码保存；返回图片 URL 时仍遵守**原有** downloadRemoteImages / allowPrivateImageHosts 下载策略，不携带 API Key。默认拒绝私网图片 URL；只有确实需要下载本机转发返回的私网 URL 时才开启 allowPrivateImageHosts: true。使用本机 API 本身不需要打开该开关。

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
dsh plugin --profile web add "D:/plugin/deepseek-harness/plugins/dsh-gpt-images/dsh-gpt-images-0.3.3.tgz"
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
    imageToolsEnabled: true
    imageApiBaseURL: 'http://localhost:8317'
    imageApiKey: ''           # 在本机安全填写，或使用下方环境变量
    imageApiKeyEnv: 'DSH_IMAGE_API_KEY'
    imageModel: 'gpt-image-2.6-flare'
    imageTimeoutMs: 300000
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

- **原有被动捕获只处理已经返回的图片**：不替模型添加 `image_generation` 工具，不强制 `modalities`；
  模型端本身没有生图能力时，需要先配置好上游。
- **被动捕获只观察当前进程的 `globalThis.fetch`**：WebSocket、子进程、Worker、自带独立 fetch 的 SDK、
  或在插件安装前就缓存了 fetch 引用的适配器不保证能捕获。
- 端点必须是 `/chat/completions`、`/responses`、`/images/generations`、`/images/edits`、
  `/messages` 或 `:generateContent` / `:streamGenerateContent` 结尾的 POST；
  被动捕获只观察当前会话的模型调用，不观察工具调用、网页请求或后台请求；新增两个工具独立调用 API 并直接保存，不受此捕获限制。
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
