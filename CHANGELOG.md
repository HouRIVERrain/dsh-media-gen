# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-10-21

### 新增

- 插件骨架：`dsh.bundle.patch` + cordis patch（`id: media-gen`，与设置命名空间同名）。
- 设置页表单：`Config` schema，17 个字段全部带 `volatile`（否则 DSH 不渲染），
  `apiKey` 带 `role('secret')`（DSH 只回传“已设置”标记，不回显密钥）。
- 密钥三条来源，按优先级：环境变量 → DSH 凭据存储（`credentialRef`）→ 配置直填。
- 模型自动探测：
  - 生图：`GET {imageBaseUrl}/models`（OpenAI 兼容面）→ 按关键词筛出图像模型；
  - 生视频：`GET {videoBaseUrl}/models?page_no=&page_size=`（native DashScope 面，分页）→ 筛出视频模型；
  - TTL 缓存 + 落盘缓存（`~/.dsh/storages/media-gen/catalog.json`，权限 0600）。
- **模型可用性区分**（2026-10-21 实测发现）：`/models` 列出的模型 ≠ 该端点可用。
  该 key 下 12 个生图模型里只有 3 个能在 `/images/generations` 上跑通
  （`qwen-image-3.0` 1.42MB/47s、`qwen-image-3.0-pro` 1.55MB/46s、`qwen-image-2.1-pro` 1.75MB/19s），
  其余是 400 `url error, please check url！` 或 404。因此：
  - 内置 `VERIFIED_IMAGE_MODELS`，自动挑选默认值时优先取其中探测到的模型；
  - `media_gen_image` 支持**失败回退**：仅在错误表示“该模型在此端点不可用”（400 url error / 404）时
    才依次试可用模型，鉴权（401/403）与限流（429）不换模型；
  - 回退时返回值带 `requestedModel` / `substituted` / `attempts`，**不偷偷换模型**；
  - `media_list_models` 会给实测可用的模型打 `← 实测可用` 标记。
- 四个工具：
  - `media_status`（只读就绪度，不含 key）
  - `media_list_models`（探测并列出模型，可 `force` 刷新）
  - `media_gen_image`（出图 + 落盘 + **图片内联回填对话**）
  - `media_gen_video`（提交→轮询→下载 mp4 + 落盘交付路径）
- 出图内联走官方 `createMcpToolDefinition`（`@deepseek-ai/dsh-mcp-client` 导出）的持久图片投影；
  拿不到该模块时自动退化为纯文本工具，不会挂掉宿主。
- 生视频协议：native DashScope 异步（`X-DashScope-Async: enable` → `output.task_id` →
  `GET /tasks/{id}` → `output.video_url`），尺寸参数按模型分流
  （MiniMax-H3 等走 `ratio`，wan 系走 `size`）。
- 产物落盘：优先 `<会话工作区>/output/images|videos`，退化到 `~/.dsh/storages/media-gen/output/`；
  下载强制 https、拒绝内网地址、限体积。
- 测试：`node test/smoke.mjs` 离线断言（注册集、参数契约、Config 表单契约、无 key 报错）；
  `--live` / `--live-video` 可跑真实生成；`test/live-from-local-config.mjs` 从本地已有配置注入 key；
  `test/verify-profile-patches.mjs` 在重启 DSH 前静态校验两份 cordis patch 与 profile 登记
  （写坏 profile patch 会让 DSH 起不来，这一步进 CI 更稳）。
- 安装辅助：`scripts/link-install.mjs` 在 `dsh` CLI 不在 PATH 时，用 junction + profile
  `package.json` 手工登记的方式完成等价安装（幂等、改前备份、自检 patch 契约）。
- **客户端半**（`lib/client.js`，`dsh.client.platform = web`，纯 JS 直发免构建）：
  - **设置里单开一页**（`settings.section`，`id: dsh-media-gen`, `order: 57`）：
    Key 状态（来源 + 掩码前缀）、填/清 Key、默认模型下拉（生图标 `← 实测可用`）、
    刷新模型目录、测试连接（两端点只读探测，只回报状态码）；
  - **对话框里选模型**：`/img`、`/vid` 两个 `ctx.commandUi` 的 `popupSelect` 命令，
    分组 + 模糊搜索 + 标出"（当前）"，选中即写回宿主，随后正常输入提示词发送即可。
- **宿主 HTTP 接口**（官方 `ctx.webServer.register`，单个 `prefix` 路由 `/dsh-media-gen` —— 
  **不能带尾斜杠**，官方匹配器比较的是 `prefix + '/'`，带尾斜杠会让所有请求静默 404）：
  `status` / `key` / `defaults` / `select` / `models` / `test` / `diag`。
  安全：改状态请求只收 `POST + application/json`（挡跨站表单）、显式拒绝 `sec-fetch-site: cross-site`、
  未知接口 404、非 POST 405、响应 `Cache-Control: no-store`，**所有响应都不含完整密钥**。
- **插件自有密钥存储** `~/.dsh/storages/media-gen/settings.json`（0600，Windows 上权限位不生效）：
  取值顺序变为 环境变量 → DSH 凭据存储 → **插件存储** → profile patch 的 `config.apiKey`。
  配套 `scripts/migrate-key-to-store.mjs`（把 patch 里的明文 key 一键搬进存储并删掉明文行，自动备份）。
- 测试：新增 `test/host-api.test.mjs`（把 `USERPROFILE` 指向临时目录跑，**不触碰真实 `~/.dsh`**）：
  存储往返、0600（POSIX 才断言）、只读视图不含密钥、路由 200/403/404/405/415、
  白名单字段、`force` 透传、**前缀匹配语义用官方规则复算**（带尾斜杠的写法会让这条当场挂掉）；
  `test/smoke.mjs` 增加"宿主路由必须注册且状态为 registered"的断言。
- **发布为作用域包 `@houriverrain/dsh-media-gen`**：npm 上非作用域同名包 `dsh-media-gen` 属他人
  （作者 mika6941，同类插件），为避撞名改用作用域。同步改动：`cordis.patch.yml` 的 `name`、
  `scripts/link-install.mjs`（改为从 package.json 读包名、支持作用域路径、清理旧登记与旧链接）、
  两份 README、`.github/workflows/ci.yml`。另修 `peerDependencies`：原先的 `^0.1.0-rc.6`
  在公共 npm 上不存在（实际只有 `0.0.1-rc.1`），会让 `npm install` 直接 ERESOLVE 失败；
  现改为 `>=0.0.1-rc.1` 且全部标 `optional`（这些包由 DSH 宿主提供，不该被安装）。

### 实测（本机，2026-10-21，插件自身代码路径）

| 项 | 结果 |
| --- | --- |
| 离线断言 | 4 工具注册、参数契约、Config 17 字段全 volatile、`apiKey` 唯一 secret —— 全通过 |
| 模型探测 | 生图 12 个、生视频 88 个（两套面都通） |
| `media_gen_image` | `qwen-image-2.1-pro`，1,356,277 字节 PNG，23.3 秒，返回体含内联图片块 |
| `media_gen_video` | `happyhorse-1.1-t2v`，3,758,056 字节 mp4，112 秒；容器实测 **`avc1` 视频 + `mp4a` 音频**双轨、**5.16 秒** |
| profile patch 体检 | 14 条操作解析正常，`mcp-cua/mcp-snowluma/mcp-media` 等原有行未被挤掉，15 bundle、链接可解析 |
| 宿主路由 | ⚠️ 首版实测 **404**（见"修复"）；改为 `ctx.inject(['webServer'], …)` 后 mock 校验为 `registered`，真机待重启复验 |

> 说明：`media_gen_video` 这次走的是 `ratio` 分流分支（happyhorse 与 MiniMax-H3 命中同一条正则、
> 组装同一种 `parameters: { ratio }`），因此该分支已被真实验证；H3 本身在上一轮的 MCP 版本里
> 用完全相同的请求体验证过（`SUCCEEDED`）。
> 测试用的 exec 没有会话工作区，产物落在退化目录 `~/.dsh/storages/media-gen/output/`；
> 真实会话中会落在 `<会话工作区>/output/{images,videos}`。

### 修复

- **宿主路由静默不注册（真机实测 404，设置页保存/清除 Key 全部失败）**：
  首版只写 `inject = ['tools']` 然后直接摸 `ctx.webServer` —— 拿到的是 `undefined`，
  `/dsh-media-gen/*` 从未注册，于是页面上每个请求都 404。
  修法照官方模式（asar 内插件开发指南原文：*"Put optional services in `inject` or
  `ctx.inject([...], ...)` so the plugin stays inactive in profiles without them instead of throwing"*，
  官方 `dsh-api-gateway` / `dsh-api-remote-access` / `dsh-client-connection` 都这么拿 `webServer`）：
  改用 `ctx.inject(['webServer'], scope => …)` 惰性注入，不把 webServer 变成硬依赖；
  注册结果记进 `state.webRoute`（`pending/registered/failed/unavailable`），`media_status` 会报出它，
  **不开浏览器也能诊断**。`test/smoke.mjs` 新增断言：mock 宿主必须走注入路径且 `webRoute === 'registered'`
  —— 这条断言在修复前是失败的，所以同类回归不会再静默通过。
- 客户端把接口错误翻译成可操作提示：`HTTP 404` → "宿主接口不存在，请重启 DSH Desktop"（正是本次现场）。

### 已知限制

- **不能出现在模型下拉框**：DSH 的模型目录只收 LLM 适配器公布、且没有任何输出模态字段，
  assistant 侧图片输出在官方文档里仍是 forward compatibility（见 README 的“为什么”）。生图/生视频只能做成工具。
- **视频不能内联显示**：官方明确视频需要“verbatim file path 之外”的专门契约，故以本地文件路径交付。
- 设置卡为 DSH 按 schema 自动生成的表单；带动态下拉的富设置卡（`settings.plugin.item` 客户端插槽）尚未实现。
- 运行时读取的是 `apply()` 时捕获的配置对象；从设置页改完参数建议重载 profile 后再用。