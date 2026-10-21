// 配置：schema（设置页表单）与解析（运行时取值）。
//
// 三条机制约束（DSH 0.2.x 实证，别改）：
//   ① 设置页的命名空间 = profile patch 里那条 entry 的 **id**（见 cordis.patch.yml 的
//      `id: media-gen`）。DSH 用 configEditor.entries().find(row => row.options.id === ns)
//      定位，再读 entry.fiber.runtime.Config 当 schema。
//   ② 只有带 `volatile` 标记的字段会进表单（dsh-settings 的 volatileForm/isVolatilePath），
//      所以每个想给用户编辑的字段都必须 .extra('volatile', true)。
//   ③ `role('secret')` 的字段会被 redactSecrets 从返回值里剥掉、只回传 presence 标记，
//      所以 API Key 适合用它；官方更推荐把 key 交给 credentials seam，配置里只留引用名。
let Schema;
try {
  // 由 DSH 宿主提供（peerDependency，走宿主的静态模块表）。
  Schema = (await import('@deepseek-ai/schemastery')).default;
} catch {
  Schema = undefined; // 拿不到 schema 也不影响工具可用，只是设置页少一张表单。
}

const volatile = (node) => node.extra('volatile', true);

export const DEFAULT_IMAGE_BASE = 'https://maas.qianwenaiapi.com/compatible-mode/v1';
export const DEFAULT_VIDEO_BASE = 'https://maas.qianwenaiapi.com/api/v1';
export const DEFAULT_API_KEY_ENV = 'DSH_MEDIA_API_KEY';

/** 插件自带的 Config：DSH「设置 → 插件」据此渲染表单。 */
export const Config = Schema?.object({
  enabled: volatile(Schema.boolean().default(true).description('总开关；关闭后工具仍注册但不发请求')),
  apiKey: Schema.string().role('secret').description('多模态 API Key（写入后只回传“已设置”标记，不回显）').extra('volatile', true),
  apiKeyEnv: volatile(Schema.string().default(DEFAULT_API_KEY_ENV).description('凭据引用名：优先读 DSH 凭据存储里的这个引用，其次读同名环境变量')),
  imageBaseUrl: volatile(Schema.string().default(DEFAULT_IMAGE_BASE).description('生图端点（OpenAI 兼容面，走 POST /images/generations）')),
  videoBaseUrl: volatile(Schema.string().default(DEFAULT_VIDEO_BASE).description('生视频端点（native DashScope 面，走 POST /services/aigc/video-generation/video-synthesis）')),
  imageModel: volatile(Schema.string().default('').description('默认生图模型；留空则用探测到的第一个可用模型')),
  videoModel: volatile(Schema.string().default('').description('默认生视频模型；留空则用探测到的第一个可用模型')),
  imageSize: volatile(Schema.string().default('1024x1024').description('默认出图尺寸（本平台必须像素写法，传 1:1 会 400）')),
  videoRatio: volatile(Schema.string().default('16:9').description('默认视频画面比例（MiniMax-H3 必须显式指定，不能 adaptive）')),
  videoSeconds: volatile(Schema.number().default(0).description('视频时长（秒）；0 = 不传，用平台默认（H3 实测默认 6.6 秒）')),
  pollIntervalMs: volatile(Schema.number().default(10000).description('视频任务轮询间隔（毫秒）')),
  videoTimeoutMs: volatile(Schema.number().default(900000).description('视频任务总超时（毫秒）；必须小于 profile 那行的 toolCallTimeoutMs')),
  outputDir: volatile(Schema.string().default('').description('产物目录；留空 = 会话工作区下的 output/images 与 output/videos')),
  maxDownloadBytes: volatile(Schema.number().default(67108864).description('单个产物下载上限（字节）')),
  autoDiscover: volatile(Schema.boolean().default(true).description('首次调用时自动探测可用模型并缓存')),
  catalogTtlMs: volatile(Schema.number().default(3600000).description('模型目录缓存有效期（毫秒）')),
  discovered: volatile(Schema.string().default('').description('（只读）最近一次探测到的模型清单摘要，仅用于在设置页里查看'))
});
// 没有 schemastery 时 Config 为 undefined：工具照常可用，只是设置页没有这张表单。

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function str(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

/** 运行时配置（把 patch 里的 config 与设置页写入的值合并后归一）。 */
export function resolveConfig(config) {
  const raw = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
  return {
    enabled: raw.enabled !== false,
    apiKey: str(raw.apiKey),
    apiKeyEnv: str(raw.apiKeyEnv, DEFAULT_API_KEY_ENV),
    imageBaseUrl: str(raw.imageBaseUrl, DEFAULT_IMAGE_BASE).replace(/\/+$/, ''),
    videoBaseUrl: str(raw.videoBaseUrl, DEFAULT_VIDEO_BASE).replace(/\/+$/, ''),
    imageModel: str(raw.imageModel),
    videoModel: str(raw.videoModel),
    imageSize: str(raw.imageSize, '1024x1024'),
    videoRatio: str(raw.videoRatio, '16:9'),
    videoSeconds: num(raw.videoSeconds, 0),
    pollIntervalMs: Math.max(2000, num(raw.pollIntervalMs, 10000)),
    videoTimeoutMs: Math.max(60000, num(raw.videoTimeoutMs, 900000)),
    outputDir: str(raw.outputDir),
    maxDownloadBytes: num(raw.maxDownloadBytes, 67108864),
    autoDiscover: raw.autoDiscover !== false,
    catalogTtlMs: Math.max(0, num(raw.catalogTtlMs, 3600000)),
    discovered: str(raw.discovered)
  };
}

/**
 * 取 key：环境变量 → DSH 凭据存储（credentialRef）→ **插件自有存储**（设置页写入的 0600 文件）
 * → profile patch 里的 config.apiKey。
 *
 * 官方立场是“配置只携带引用、密钥不进配置文件”，插件自有存储就是为此准备的落点：
 * 设置页写它、不回显它，profile patch 里可以一行 key 都不留。
 */
export async function resolveApiKey(ctx, cfg) {
  const envName = cfg.apiKeyEnv || DEFAULT_API_KEY_ENV;
  const fromEnv = process.env[envName];
  if (fromEnv && fromEnv.trim()) return { key: fromEnv.trim(), source: `env:${envName}` };
  try {
    const mod = await import('@deepseek-ai/dsh-credentials');
    const ref = mod.credentialRef(envName);
    const resolved = await ctx?.credentials?.resolve?.(ref);
    if (resolved?.value) return { key: String(resolved.value).trim(), source: `credentials:${envName}` };
  } catch {
    // 宿主没有凭据 seam（或旧版本）时静默跳过，继续看后面的来源。
  }
  try {
    const { readStore } = await import('./store.js');
    const stored = String(readStore().apiKey ?? '').trim();
    if (stored) return { key: stored, source: 'store:settings.json' };
  } catch {
    // 存储文件读不了也不影响其它来源。
  }
  if (cfg.apiKey) return { key: cfg.apiKey, source: 'config:apiKey' };
  return { key: '', source: 'none' };
}