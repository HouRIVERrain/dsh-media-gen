# dsh-media-gen

给 **DeepSeek Harness（DSH）** 用的生图 / 生视频插件：填一次 API Key，插件自动探测你能用的模型，然后直接对助手说「画一只戴耳机的橘猫」或「生成一段 5 秒视频」即可。

- **图片内联显示在对话里**（走官方持久图片投影，不是给个链接让你自己点）
- **视频落盘交付**（mp4 文件路径；DSH 目前没有视频内联契约）
- **两套 API 面一次探测**：生图走 OpenAI 兼容面，生视频走 native DashScope 面（后者列出 88 个视频模型，兼容面完全看不到）
- **「清单里有」≠「能用」，而且插件会明说**：参考网关上 12 个生图模型只有 3 个真能跑；插件维护实测可用清单、请求的模型不可用时自动回退，并在结果里如实标注 `substituted`
- **自带设置页**（设置 → 生图 / 生视频）：Key 状态、掩码、默认模型下拉、刷新目录、测试连接，**不需要改 YAML**
- **对话框里选模型**：`/img`、`/vid` 弹出可搜索的分组模型列表，选中后下一次生成就用它

> 名称说明：npm 上另有一个**同名的非作用域包** `dsh-media-gen`（作者与代码库均不同，见第七节）。
> 本包发布在 `@houriverrain` 作用域下以避免撞名，与那个包**没有关系**。

---

## 一、安装

```powershell
# 1) 从 npm（作用域包）
dsh plugin --profile desktop add @houriverrain/dsh-media-gen

# 2) 从 GitHub（钉提交更稳）
dsh plugin --profile desktop add github:HouRIVERrain/dsh-media-gen#<sha>

# 3) 本地开发（本仓库目录）
dsh plugin --profile desktop add link:C:\path\to\dsh-media-gen
```

装完**重启 DSH**（或改一下 profile patch 触发宿主 HMR 热重载）。

也可以完全不装 CLI：直接跑 `node scripts/link-install.mjs desktop`（包名从 package.json 自动读取，
作用域包会落到 `node_modules/@scope/` 下，并顺手清掉改名前的旧登记与旧链接）。

## 二、配置

设置 → **生图 / 生视频**（插件自带的独立设置页）：Key 状态与掩码前缀、填/清 Key、默认模型下拉、
刷新模型目录、测试连接，**日常只在这一页操作，不需要改任何 YAML**。

同一份配置也仍然出现在**设置 → 插件**里（表单由插件的 `Config` schema 自动渲染；`apiKey` 是
`role('secret')`，写入后只回传"已设置"，不回显）—— 两条路改的是同一份配置。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `apiKey` | 空 | 多模态 API Key（**secret**，不回显） |
| `apiKeyEnv` | `DSH_MEDIA_API_KEY` | 凭据引用名：先读 DSH 凭据存储里的该引用，再读同名环境变量 |
| `imageBaseUrl` | 千问 MaaS 兼容面 | 生图端点（`POST /images/generations`） |
| `videoBaseUrl` | 千问 MaaS native 面 | 生视频端点（DashScope 异步协议） |
| `imageModel` / `videoModel` | 空 | 留空 = 自动选用模型（生图优先选**实测可用**的那几个，见下节） |
| `imageSize` | `1024x1024` | 出图尺寸（**必须像素写法**，传 `1:1` 会 400） |
| `videoRatio` | `16:9` | 视频比例（H3 必须显式给，不能 `adaptive`） |
| `videoSeconds` | `0` | 0 = 不传，用平台默认（H3 实测 6.6 秒） |
| `pollIntervalMs` / `videoTimeoutMs` | `10000` / `900000` | 轮询间隔与总超时 |
| `outputDir` | 空 | 产物目录；留空 = `<会话工作区>/output/{images,videos}` |
| `autoDiscover` / `catalogTtlMs` | `true` / `3600000` | 自动探测与目录缓存 TTL |

**Key 的四条来源**（按优先级）：环境变量 `apiKeyEnv` → DSH 凭据存储（`ctx.credentials`，官方推荐的"配置只带引用"）→ **插件自有存储** `~/.dsh/storages/media-gen/settings.json`（设置页写入，0600；Windows 上 POSIX 权限位不生效，属尽力而为）→ profile patch 里的 `config.apiKey`。

> **日常就只用第一条路径的界面版**：装完后到「设置 → 生图 / 生视频」填 Key 即可，**不需要碰任何 YAML**。
> 若你手上已经有一份把 key 写在 patch 里的旧配置，用
> `node scripts/migrate-key-to-store.mjs --remove --profile desktop` 一键搬进插件存储并删掉明文行（会自动备份）。

> ⚠️ `toolCallTimeoutMs`：`cordis.patch.yml` 里那一行没设超时（DSH 默认 60s 会掐断长任务）。
> 自己做视频建议加上：
> ```yaml
> - id: media-gen
>   name: dsh-media-gen
>   config:
>     videoTimeoutMs: 900000
> ```
> 并在 profile patch 里给该 entry 配 `toolCallTimeoutMs`（参考本机 `mcp-media` 用的 `1800000`）。

## 三、实测可用模型（重要：清单里有 ≠ 能用）

`GET /models` 会列出该 key 的全部模型，但**它们不一定能在 `/images/generations` 上跑**。
2026-10-21 在千问 MaaS 上逐个真跑的结果（12 个生图模型）：

| 模型 | 结果 | 价格 |
| --- | --- | --- |
| `qwen-image-3.0` | ✅ 1.42MB / 47s | ¥0.18/张（1K 与 2K 同价） |
| `qwen-image-3.0-pro` | ✅ 1.55MB / 46s | ¥0.25/张（1K）、¥0.5（2K） |
| `qwen-image-2.1-pro` | ✅ 1.75MB / **19s** | ¥0.25/张 |
| `wan2.7-image`、`qwen-image-2.0`、`qwen-image-2.0-2026-03-03` | ❌ HTTP 400 `url error, please check url！` | — |
| `z-image-turbo` | ❌ HTTP 404（空 body） | — |
| 其余（`*-pro` 的 2.0 系列、`wan2.7-image-pro`） | 未逐一实测（贵档，¥0.5/张） | — |

因此插件内置 `VERIFIED_IMAGE_MODELS = ['qwen-image-3.0', 'qwen-image-2.1-pro', 'qwen-image-3.0-pro']`：

- **自动挑选**默认值时会优先取这三个里探测到的那个，而不是清单第一个；
- **失败回退**：只有错误明确表示“该模型在此端点不可用”（400 `url error` / 404）时，才依次试这三个；
  鉴权失败（401/403）或限流（429）**不会**换模型（换了也没意义）；
- 回退发生时，返回值里会给出 `requestedModel` + `substituted` + `attempts`，**不会**偷偷换模型。

## 四、工具

| 工具 | 作用 |
| --- | --- |
| `media_status` | 只读：key 来源、两端点、默认模型、缓存目录、最近错误（**不含 key**） |
| `media_list_models` | 探测并列出可用生图/生视频模型（`kind` / `force`），**标出实测可用的** |
| `media_gen_image` | 出图 → 落盘 → **图片内联回显**（可用 `model` 按次覆盖，失败自动回退） |
| `media_gen_video` | 提交 → 轮询 → 下载 mp4 → 返回文件路径 |

### 在对话里换模型

没有下拉框（原因见第六节），但**可以按次点名**：

> 「用 qwen-image-3.0-pro 画一只戴耳机的橘猫」

助手会把这句话转成 `media_gen_image({ model: 'qwen-image-3.0-pro', ... })`。
想换**默认**模型，改设置页的 `imageModel`（或 profile patch 里那一行）。

## 五、协议与实测记录（2026-10-21 于千问 MaaS）

同一个网关有**两套能力不同的面**，这是本插件最关键的一条经验：

| | OpenAI 兼容面 | native DashScope 面 |
| --- | --- | --- |
| baseURL | `/compatible-mode/v1` | `/api/v1` |
| 模型数 | 178（**一个视频模型都没有**） | 356（**视频类 88 个**） |
| 生图 | ✅ `POST /images/generations` | — |
| 生视频 | ❌ `/videos` → **404 空 body** | ✅ `POST /services/aigc/video-generation/video-synthesis` |

- 视频提交必须带 `X-DashScope-Async: enable`，返回 `output.task_id`；轮询 `GET /api/v1/tasks/{id}`。
- **尺寸参数因模型而异**：MiniMax-H3 只认 `parameters.ratio`（实测报错原文：
  `t2va(纯文本)场景必须显式指定 ratio 且不能为 adaptive`），wan 系认 `parameters.size: 1280*720`。
- 实测：`qwen-image-3.0` 出 1024×1024 约 55 秒；`MiniMax/MiniMax-H3` 出 6.58 秒
  （H.264 + AAC 双轨）耗时 6 分 44 秒。
- 价格参考：`MiniMax/MiniMax-H3` 768P ¥0.5/秒、2K ¥0.8/秒；`wan2.7-t2v` 720P ¥0.6/秒；
  `kling/kling-v3` 720P ¥0.9/秒（无声 ¥0.6）。

## 六、为什么生图/生视频**不能**做成模型下拉框里的模型

这是被官方契约封死的，不是实现偷懒。四条证据（均可在 DSH 安装包的 `@deepseek-ai/*` 包里复核）：

1. `ModelModalityMap { text: 'text'; image: 'image' }`；`LlmModelInfo` 只有 `inputModalities`，
   **不存在任何输出模态字段**（没有 `output` / `outputModalities` / `capabilities` / `kind`）。
2. `dsh-llm-pi-ai` 源码：`case "image": throw new LlmError("pi-ai chat history cannot represent
   structured assistant image output", "UNSUPPORTED_CONTENT")`。
3. `dsh-attachment` README：*“Audio and video would need dedicated lifecycle and provider contracts
   beyond the verbatim file path, and the role-neutral `ImageBlock` leaves assistant-side image output
   as **forward compatibility** — current production adapters declare text-only output.”*
4. `dsh-client-ui-model-selection` README：客户端插槽 `conversation.input.model.label`
   *“must render **non-interactive** inline content … The selector owns clicks, search, focus,
   disabled states, check marks.”* —— 只能改标签外观，改不了“选中后发生什么”。

结论：生图/生视频的唯一受支持落地路径是**工具 + 附件/文件 + 工具结果投影**（本插件即此形态），
而模型下拉框只服务聊天模型。

## 七、与社区插件的关系

- 生图：[`@goodandready/dsh-image-gen`](https://www.npmjs.com/package/@goodandready/dsh-image-gen)
  已经很成熟（8 个后端、15 个工具、内联显示、设置卡）。本插件不重复造它的后端矩阵。
- **生视频**：本插件的主要价值之一 —— 把 DashScope 异步视频协议、模型分流参数、长任务轮询与落盘交付
  做成开箱可用。但这个位置**并非空白**：
  [`dsh-media-gen`](https://www.npmjs.com/package/dsh-media-gen)（作者 mika6941，非作用域同名包）与
  `dsh-video-gen` 都已经在做生图+生视频。**本包与它们没有关系**，发布在 `@houriverrain` 作用域下以避免撞名；
  工具名也不同（本包是 `media_gen_image` / `media_gen_video`）。
  如果两个插件都装了，`/img`、`/vid` 这两个命令名可能撞车——DSH 在这种情况下会明确报错而不是静默覆盖，
  本插件也会把注册状态显示在设置页和 `media_status` 里。

## 八、开发与测试

```powershell
cd dsh-media-gen
npm test                    # 离线：注册集、参数契约、Config 表单契约、宿主接口、无 key 报错
npm run test:host-api       # 单独跑宿主 HTTP 接口测试（用临时 HOME，不碰你真实 ~/.dsh）
npm run test:live           # 真出 1 张图（花钱）
npm run test:live-video     # 真出 1 段视频（1~7 分钟，花钱）
npm run install:local       # dsh CLI 不在 PATH 时的手工等价安装
npm run verify:patches      # 重启 DSH 前静态校验 profile patch
```

**不需要 `npm install` 就能跑测试**：运行期依赖（`dsh-tools` / `schemastery` / `mcp-client`）
全部由 DSH 宿主提供，缺失时插件优雅退化（工具照常注册，只是设置表单少一张 schema 表单）。
`npm install` 只装一个 devDependency（`schemastery`），用来让「Config 表单契约」那几条断言真的跑起来。
`peerDependencies` 全部标了 `optional`，所以 npm 不会去装宿主的包。

**没有构建步骤**：客户端半是纯 JS，用 `window.__ModuleLoader__.load(...)` 加载，格式与官方客户端插件一致。

**宿主 HMR 小技巧**：插件是 `link:` 安装的，改完文件后**改一下 profile patch**即可让 DSH
无需重启就重载它（`@deepseek-ai/dsh-hmr` 的官方行为）—— 本仓库几个宿主侧修复就是这么现场验证的。

## 九、发布信息

## 十、限制与路线图

- 视频不内联（官方无契约），以文件路径交付。
- 设置卡是 schema 自动表单；**带动态下拉的富设置卡**（`settings.plugin.item` 客户端插槽 +
  `tool.call.toolview` 结果卡片）尚未实现，属于下一步。
- 运行时读的是 `apply()` 时捕获的配置对象；改完设置建议重载 profile。
- 图生视频（`imageUrl`）已实现参数通路，但未在本机实测。

## 十一、设置页与「对话里选模型」（客户端半）

插件带一个**浏览器端半**（`lib/client.js`，形态照抄官方可用的第三方客户端插件：`window.__ModuleLoader__.load(...)`，**纯 JS 直发、不需要构建步骤**），提供两件事：

### 1. 设置里单开一页

「设置 → **生图 / 生视频**」（注册在 `settings.section` 插槽，`id: dsh-media-gen`, `order: 57`）：

- **Key 状态**：显示来源（`env:` / `credentials:` / `store:` / `config:`）与掩码前缀，永不回显完整密钥；
- **填 / 清 Key**：写入插件自有存储（`settings.json`，0600）；清空后自动回落到环境变量/凭据存储/patch；
- **默认模型下拉**：生图下拉会标出 `← 实测可用`；
- **刷新模型目录**、**测试连接**（两端点各打一次只读 `/models`，只回报状态码）。

### 2. 对话框里选模型

在输入框键入 `/img`（生图）或 `/vid`（生视频）→ 弹出**分组、可模糊搜索**的模型列表 → 选中即写回宿主（存为"下次生成用这个模型"）。
之后你**正常输入提示词发送**即可 —— 助手调用生成工具时，插件会优先用你刚选的那个模型。

> 为什么不是 composer 的模型下拉框：那个位置只服务聊天模型（见第六节的四条证据）。`/img`、`/vid` 是官方 `ctx.commandUi` 的 `popupSelect` 能力，属于受支持的做法。

### 它怎么和宿主通信

客户端不直接读文件，而是打插件自己的宿主接口（官方 `ctx.webServer.register`，**一个** `prefix` 路由 `/dsh-media-gen/`）：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/dsh-media-gen/status` | 就绪度、key 来源与掩码、目录、端点、超时（**不含密钥**） |
| POST | `/dsh-media-gen/key` | 写入/清除 Key |
| POST | `/dsh-media-gen/defaults` | 保存默认生图/生视频模型 |
| POST | `/dsh-media-gen/select` | 命令弹窗选中模型后写回 |
| POST | `/dsh-media-gen/models` | 刷新目录（`{force:true}`） |
| POST | `/dsh-media-gen/test` | 两端点连通性测试 |

安全：改状态的请求只接受 `POST + application/json`（跨站 JSON 会触发预检而我们不回 CORS 头），并显式拒绝 `sec-fetch-site: cross-site`。
**威胁模型如实说明**：这挡网页侧 CSRF 与误触发，挡不住同机的其他进程（他们本来就能读写同一份文件）。

## License

MIT