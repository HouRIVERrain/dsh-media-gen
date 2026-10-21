/**
 * dsh-media-gen —— DSH 生图 / 生视频插件。
 *
 * 装一个插件，得到三件事：
 *   1. 设置页表单（命名空间 media-gen）：填 API Key / 两个端点 / 默认模型与尺寸；
 *   2. 自动模型探测：生图走 OpenAI 兼容面、生视频走 native DashScope 面，带 TTL 缓存；
 *   3. 四个工具：media_status / media_list_models / media_gen_image / media_gen_video，
 *      其中出图结果经官方 `createMcpToolDefinition` 的投影**直接显示在对话里**。
 *
 * 设计边界（有实证，别越界）：
 *   · DSH 的模型下拉框只收 LLM 适配器 `listModels()` 公布的**聊天**模型，
 *     `LlmModelInfo` 没有任何“输出模态”字段，assistant 侧图片输出在官方文档里
 *     仍只是 forward compatibility —— 所以生图/生视频**不能**做成下拉框里的模型，
 *     只能做成工具。详见 README 的“为什么不在模型下拉框里”。
 *   · 视频没有内联契约（官方：需要 verbatim file path 之外的专门契约），
 *     所以视频以**本地文件路径**交付，图片才内联。
 *
 * @module dsh-media-gen
 */
import { Config, resolveConfig, resolveApiKey } from './config.js';
import {
  discoverModels, cachedCatalog, generateImage, generateVideo,
  saveBuffer, mediaSlug, stamp, summarize, VERIFIED_IMAGE_MODELS
} from './media.js';
import { buildTools, outputDirs } from './tools.js';
import { readStore } from './store.js';
import { createRouteHandler } from './host-api.js';

export const name = 'dsh-media-gen';
/** tools 是硬依赖；credentials / settings 是可选能力，用得到时才动态取，缺了也能跑。 */
export const inject = ['tools'];
export { Config };

const errorContent = (message) => ({ content: [{ type: 'text', text: String(message) }], isError: true });

export function apply(ctx, config = {}) {
  const warn = (m) => { try { ctx?.logger?.warn?.(`[dsh-media-gen] ${m}`); } catch {} };
  const captured = resolveConfig(config);

  /** 供 HTTP 接口读取的运行时状态（目录、端点、实测可用清单）。 */
  const state = {
    cfg: captured,
    catalog: null,
    verifiedImageModels: VERIFIED_IMAGE_MODELS
  };

  /** 设置页的「测试连接」：两端点各打一次只读 /models，只回报状态码。 */
  async function probeEndpoints() {
    const { key, source } = await resolveApiKey(ctx, captured);
    if (!key) return { ok: false, error: '没有可用的 API Key', probes: [] };
    const targets = [
      ['生图端点', `${captured.imageBaseUrl}/models`],
      ['生视频端点', `${captured.videoBaseUrl}/models?page_no=1&page_size=5`]
    ];
    const probes = [];
    for (const [label, url] of targets) {
      try {
        const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30000) });
        probes.push({ label, url, status: res.status, ok: res.ok });
      } catch (error) {
        probes.push({ label, url, status: 0, ok: false, error: String(error?.message ?? error) });
      }
    }
    return { ok: probes.every((probe) => probe.ok), keySource: source, probes };
  }

  /** 目录优先用缓存；需要时探测。返回 { catalog, key, keySource }。 */
  async function ensureCatalog({ force = false } = {}) {
    const { key, source } = await resolveApiKey(ctx, captured);
    if (!key) throw new Error('没有可用的 API Key：请在「设置 → 生图 / 生视频」里填写（插件自有存储），'
      + `或设置环境变量 ${captured.apiKeyEnv}，或写入 DSH 凭据存储的该引用，或在 profile patch 的 config.apiKey 里填`);
    if (!captured.autoDiscover && !force) {
      const c = cachedCatalog();
      if (c.image.length || c.video.length) {
        state.catalog = c;
        return { catalog: c, key, keySource: source };
      }
    }
    const catalog = await discoverModels(captured, key, { force });
    state.catalog = catalog;
    return { catalog, key, keySource: source };
  }

  /**
   * 模型自动挑选：显式配置 > 实测可用清单里的第一个 > 探测结果第一个。
   * 生图这里优先 VERIFIED_IMAGE_MODELS——因为清单里有 ≠ 端点能用（实测 12 个里只有 3 个可用）。
   */
  function pickModel(catalog, kind) {
    if (kind === 'image') {
      const preferred = VERIFIED_IMAGE_MODELS.find((m) => catalog.image.includes(m));
      const chosen = storedDefault('imageModel');
      const picked = chosen || captured.imageModel || preferred || catalog.image[0] || '';
      if (!captured.imageModel && picked) captured.imageModel = picked;
      return picked;
    }
    const picked = storedDefault('videoModel') || captured.videoModel || catalog.video[0] || '';
    if (!captured.videoModel && picked) captured.videoModel = picked;
    return picked;
  }

  /** 设置页保存的默认模型（插件自有存储）；读不到就返回空串。 */
  function storedDefault(field) {
    try { return String(readStore()[field] ?? '').trim(); } catch { return ''; }
  }

  /** 命令弹窗刚选中的模型（优先级高于保存的默认值）。 */
  function storedSelection(kind) {
    try {
      const store = readStore();
      return String((kind === 'image' ? store.selectedImageModel : store.selectedVideoModel) ?? '').trim();
    } catch { return ''; }
  }

  const api = {
    async run(toolName, args, exec) {
      try {
        if (!captured.enabled && toolName !== 'media_status') {
          return errorContent('插件已被 disabled（设置里的 enabled=false）。');
        }

        if (toolName === 'media_status') {
          const { key, source } = await resolveApiKey(ctx, captured);
          const c = cachedCatalog();
          const payload = {
            ready: Boolean(key),
            keySource: source,
            enabled: captured.enabled,
            imageBaseUrl: captured.imageBaseUrl,
            videoBaseUrl: captured.videoBaseUrl,
            imageModel: captured.imageModel || null,
            videoModel: captured.videoModel || null,
            imageSize: captured.imageSize,
            videoRatio: captured.videoRatio,
            videoSeconds: captured.videoSeconds || null,
            cachedAt: c.at ? new Date(c.at).toISOString() : null,
            imageModels: c.image.length,
            videoModels: c.video.length,
            catalogSummary: c.image.length || c.video.length ? summarize(c) : null,
            // 浏览器设置页靠这条宿主路由；这里报出它的注册状态，便于不开浏览器就能诊断。
            webRoute: state.webRoute ?? 'pending',
            webRouteError: state.webRouteError ?? null,
            lastError: c.error
          };
          return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
        }

        if (toolName === 'media_list_models') {
          const kind = String(args.kind || 'all');
          const { catalog, keySource } = await ensureCatalog({ force: args.force === true });
          const lines = [`key 来源：${keySource}`];
          if (kind !== 'video') {
            // 标出“实测可用”的模型：清单里有 ≠ 该端点能用（实测 12 个生图模型只有 3 个可用）。
            const marked = catalog.image.map((id) => (VERIFIED_IMAGE_MODELS.includes(id) ? `${id}  ← 实测可用` : id));
            lines.push(`生图模型（${catalog.image.length}，标 ← 的已实测可用）：\n` + (marked.join('\n') || '（无）'));
          }
          if (kind !== 'image') lines.push(`生视频模型（${catalog.video.length}）：\n` + (catalog.video.join('\n') || '（无）'));
          if (catalog.error) lines.push(`部分探测失败：${catalog.error}`);
          lines.push(`默认选用：生图 ${pickModel(catalog, 'image') || '（无）'}；生视频 ${pickModel(catalog, 'video') || '（无）'}`);
          lines.push('提示：指定 model 时会按次覆盖默认值；若该模型在该端点不可用，会自动回退到实测可用的模型并在返回值里说明。');
          return { content: [{ type: 'text', text: lines.join('\n\n') }] };
        }

        if (toolName === 'media_gen_image') {
          const prompt = String(args.prompt ?? '').trim();
          if (!prompt) return errorContent('prompt 不能为空。');
          const { catalog, key } = await ensureCatalog({});
          const requested = String(args.model || storedSelection('image') || pickModel(catalog, 'image') || '').trim();

          // 失败回退：仅当错误表示“该模型在此端点不可用”（400 url error / 404）时，
          // 才依次试 VERIFIED_IMAGE_MODELS。鉴权/限流错误换模型没意义，直接抛出。
          const chain = [requested, ...VERIFIED_IMAGE_MODELS].filter((m, i, a) => m && a.indexOf(m) === i);
          const attempts = [];
          let out = null;
          for (const candidate of chain) {
            try {
              out = await generateImage(captured, key, { prompt, size: args.size, model: candidate });
              break;
            } catch (error) {
              attempts.push({ model: candidate, httpStatus: error?.code ?? null, message: String(error?.message ?? error) });
              if (!error?.modelUnavailable) break;
            }
          }
          if (!out) {
            return errorContent(`出图失败，已尝试：\n${attempts.map((a) => `- ${a.model}（HTTP ${a.httpStatus}）：${a.message.split('\n')[0]}`).join('\n')}`);
          }

          const { dirs, requestedDir, workspace } = outputDirs(captured, exec, 'images');
          const filename = `${args.filename ? mediaSlug(args.filename) : mediaSlug(prompt)}-${stamp()}.png`;
          const { file } = saveBuffer(out.buffer, { dirs, filename, requestedDir, workspace });
          const meta = {
            file, bytes: out.buffer.length, model: out.model, ms: out.ms,
            requestedModel: requested,
            substituted: out.model === requested ? null : `指定的 ${requested} 在该端点不可用，已自动改用 ${out.model}`,
            attempts: attempts.length ? attempts : null,
            prompt, sourceUrl: out.sourceUrl ? '（已即时下载，链接为带签名的临时地址）' : null
          };
          return {
            content: [
              { type: 'text', text: JSON.stringify(meta, null, 2) },
              { type: 'image', data: out.buffer.toString('base64'), mimeType: 'image/png' }
            ]
          };
        }

        if (toolName === 'media_gen_video') {
          const prompt = String(args.prompt ?? '').trim();
          if (!prompt) return errorContent('prompt 不能为空。');
          const { catalog, key } = await ensureCatalog({});
          const model = String(args.model || storedSelection('video') || pickModel(catalog, 'video') || '').trim();
          const out = await generateVideo(captured, key, {
            prompt, model,
            ratio: args.ratio, size: args.size, seconds: args.seconds, imageUrl: args.imageUrl
          });
          const { dirs, requestedDir, workspace } = outputDirs(captured, exec, 'videos');
          const filename = `${args.filename ? mediaSlug(args.filename) : mediaSlug(prompt)}-${stamp()}.mp4`;
          const { file } = saveBuffer(out.buffer, { dirs, filename, requestedDir, workspace });
          const meta = {
            file, bytes: out.buffer.length, model: out.model, taskId: out.taskId, ms: out.ms,
            parameters: out.params, sizeParamStyle: out.style, statusLog: out.log.slice(-8),
            note: '视频没有内联显示契约，交付的是本地文件路径；可用侧栏文件/预览打开'
          };
          return { content: [{ type: 'text', text: JSON.stringify(meta, null, 2) }] };
        }

        return errorContent(`未知工具：${toolName}`);
      } catch (error) {
        return errorContent(`${toolName} 失败：${error?.message ?? error}`);
      }
    }
  };

  const disposers = [];
  // buildTools 是 async（内部动态 import 官方 mcp-client），注册放进异步链，失败只告警不炸宿主。
  const registration = buildTools(ctx, api)
    .then((definitions) => {
      for (const definition of definitions) {
        try {
          disposers.push(ctx.tools.register(definition));
        } catch (error) {
          warn(`工具 ${definition?.name} 注册失败：${error?.message ?? error}`);
        }
      }
      return definitions.map((d) => d.name);
    })
    .catch((error) => {
      warn(`工具构建失败，插件空转：${error?.message ?? error}`);
      return [];
    });

  // 便于宿主与测试观测。
  api.ready = registration;
  api.state = state;

  // 浏览器端（设置页 / 命令弹窗）用的 HTTP 接口。
  //
  // 官方契约（dsh-host-webserver）：ctx.webServer.register({ kind, path, handler }) 返回 disposer；
  // 同一张路由表内重复路径会抛错，所以只用 /dsh-media-gen/ 一个前缀路由。
  //
  // ⚠️ 踩过的坑（2026-10-21 实测 404）：**webServer 必须经注入拿到**。
  //    官方 dsh-client-hmr 写的是 `const inject = ["clientModules", "webServer"]`；
  //    只写 `inject = ['tools']` 然后直接摸 `ctx.webServer`，拿到的是 undefined，
  //    路由会静默不注册 → 设置页一切请求 404。
  //    这里用 cordis 的惰性注入 `ctx.inject(['webServer'], cb)`：服务就绪时回调执行，
  //    而且不把 webServer 变成硬依赖（非 Web 组合下工具照常可用）。
  const registerRoute = (webServer) => {
    try {
      disposers.push(webServer.register(createRouteHandler({
        state,
        resolveKey: () => resolveApiKey(ctx, captured),
        ensureCatalog: async ({ force } = {}) => (await ensureCatalog({ force })).catalog,
        probeEndpoints
      })));
      state.webRoute = 'registered';
    } catch (error) {
      state.webRoute = 'failed';
      state.webRouteError = String(error?.message ?? error);
      warn(`HTTP 接口注册失败（浏览器设置页会不可用，工具不受影响）：${error?.message ?? error}`);
    }
  };

  state.webRoute = 'pending';
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer'], (scope) => registerRoute(scope.webServer));
    } catch (error) {
      state.webRoute = 'failed';
      state.webRouteError = String(error?.message ?? error);
      warn(`webServer 注入失败：${error?.message ?? error}`);
    }
  } else if (typeof ctx.webServer?.register === 'function') {
    registerRoute(ctx.webServer);
  } else {
    state.webRoute = 'unavailable';
    warn('宿主没有 webServer 服务，浏览器设置页不可用；工具仍照常工作。');
  }

  if (typeof ctx.on === 'function') {
    ctx.on('dispose', () => {
      for (const dispose of disposers) {
        try { dispose(); } catch {}
      }
    });
  }

  return api;
}

export { resolveConfig } from './config.js';
export { discoverModels, generateImage, generateVideo, summarize, VERIFIED_IMAGE_MODELS } from './media.js';
export { TOOL_NAMES } from './tools.js';