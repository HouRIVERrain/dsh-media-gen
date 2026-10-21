// 宿主 HTTP 接口：给浏览器端（设置页 / 命令弹窗）读写配置与查模型。
//
// 注册方式（官方 dsh-host-webserver 契约）：
//   ctx.webServer.register({ kind: 'prefix', path: '/dsh-media-gen/', handler })，返回 disposer。
//   同一张表内重复路径会抛错，所以只用**一个**前缀路由，内部自己分发。
//
// 安全（本地 webserver 没有 DSH 的 /api 会话鉴权，所以自己加两道闸）：
//   ① 改状态的请求只接受 POST + Content-Type: application/json；
//      带 JSON content-type 的跨站 POST 会触发 CORS 预检，而我们不回 CORS 头 → 浏览器侧被封住。
//   ② 显式拒绝 sec-fetch-site: cross-site。
//   威胁模型如实说明：这挡不住同机的其他进程/用户（他们本来就能读写同一份文件），
//   目标是挡住网页侧的 CSRF 与误触发。
import { readStore, writeStore, clearStore, storeView, keyHint } from './store.js';

// ⚠️ 路径**不能带尾斜杠**。官方 dsh-host-webserver 的匹配规则是
//   `if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue;`
// 也就是它拿 "prefix + '/'" 去比。注册成 '/dsh-media-gen/' 的话，比较串变成
// '/dsh-media-gen//'，而 '/dsh-media-gen/status' 永远匹配不上 ——
// 现象极具迷惑性：register() 不抛错、路由"注册成功"，但所有请求 404。
// 官方一律写 '/api'、'/plugins' 这种不带尾斜杠的形式。
export const ROUTE_PREFIX = '/dsh-media-gen';

function send(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readJsonBody(req, limitBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) { resolve({}); return; }
      try { resolve(JSON.parse(text)); } catch (error) { reject(new Error(`请求体不是合法 JSON：${error.message}`)); }
    });
    req.on('error', reject);
  });
}

function crossSite(req) {
  const site = String(req.headers['sec-fetch-site'] ?? '').toLowerCase();
  return site === 'cross-site';
}

/**
 * 建路由。deps 由 index.js 注入，避免这里再依赖插件内部状态：
 *   { state, resolveKey, ensureCatalog, probeEndpoints }
 */
export function createRouteHandler(deps) {
  const { state, resolveKey, ensureCatalog, probeEndpoints } = deps;

  return {
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      // 前缀不带尾斜杠，所以这里要把两侧的斜杠都削掉：
      // '/dsh-media-gen/status' → 'status'；'/dsh-media-gen' → 'status'（默认）。
      const action = url.pathname.slice(ROUTE_PREFIX.length).replace(/^\/+|\/+$/g, '') || 'status';
      const method = String(req.method ?? 'GET').toUpperCase();

      if (crossSite(req)) { send(res, 403, { error: 'cross-site 请求被拒绝' }); return; }

      // 未知接口先判 404，否则会被下面的“非 POST 即 405”吞掉（之前的顺序就踩了这个坑）。
      const KNOWN = new Set(['status', 'key', 'defaults', 'select', 'models', 'test', 'diag']);
      if (!KNOWN.has(action)) { send(res, 404, { error: `未知接口 ${action}` }); return; }

      try {
        if (action === 'status' && (method === 'GET' || method === 'HEAD')) {
          const { key, source } = await resolveKey();
          const catalog = state.catalog ?? { image: [], video: [], error: null };
          send(res, 200, {
            ok: true,
            ready: Boolean(key),
            keySource: source,
            keyHint: keyHint(key),
            store: storeView(),
            config: {
              imageBaseUrl: state.cfg.imageBaseUrl,
              videoBaseUrl: state.cfg.videoBaseUrl,
              imageModel: state.cfg.imageModel || null,
              videoModel: state.cfg.videoModel || null,
              videoRatio: state.cfg.videoRatio,
              verifiedImageModels: state.verifiedImageModels
            },
            catalog: {
              images: catalog.image ?? [],
              videos: catalog.video ?? [],
              error: catalog.error ?? null,
              at: catalog.at ?? null
            },
            // 浏览器端最近一次回报的命令注册诊断（未回报则为 null）。
            clientDiag: state.clientDiag ?? null,
            toolTimeouts: { videoTimeoutMs: state.cfg.videoTimeoutMs, pollIntervalMs: state.cfg.pollIntervalMs }
          });
          return;
        }

        if (method !== 'POST') { send(res, 405, { error: `不支持 ${method} ${url.pathname}` }); return; }
        const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
        if (!contentType.includes('application/json')) {
          send(res, 415, { error: '只接受 Content-Type: application/json（挡跨站表单提交）' });
          return;
        }
        const body = await readJsonBody(req);

        if (action === 'key') {
          const value = String(body.apiKey ?? '').trim();
          if (value) writeStore({ apiKey: value });
          else clearStore();
          send(res, 200, { ok: true, ...storeView() });
          return;
        }

        if (action === 'defaults') {
          const patch = {};
          if (Object.hasOwn(body, 'imageModel')) patch.imageModel = String(body.imageModel ?? '').trim();
          if (Object.hasOwn(body, 'videoModel')) patch.videoModel = String(body.videoModel ?? '').trim();
          if (Object.hasOwn(body, 'videoRatio')) patch.videoRatio = String(body.videoRatio ?? '').trim();
          if (Object.hasOwn(body, 'videoSeconds')) patch.videoSeconds = Number(body.videoSeconds) || 0;
          writeStore(patch);
          send(res, 200, { ok: true, ...storeView() });
          return;
        }

        // 命令弹窗选中模型 → 存为“下次生成用的模型”，工具在未显式指定时采用它。
        if (action === 'select') {
          const kind = String(body.kind ?? '').toLowerCase();
          const model = String(body.model ?? '').trim();
          if (kind !== 'image' && kind !== 'video') { send(res, 400, { error: 'kind 只能是 image 或 video' }); return; }
          if (!model) { send(res, 400, { error: 'model 不能为空' }); return; }
          writeStore(kind === 'image' ? { selectedImageModel: model } : { selectedVideoModel: model });
          send(res, 200, { ok: true, kind, model, ...storeView() });
          return;
        }

        if (action === 'models') {
          const catalog = await ensureCatalog({ force: body.force === true });
          send(res, 200, {
            ok: true,
            verifiedImageModels: state.verifiedImageModels,
            images: catalog.image ?? [],
            videos: catalog.video ?? [],
            error: catalog.error ?? null,
            at: catalog.at ?? null
          });
          return;
        }

        if (action === 'test') {
          const result = await probeEndpoints();
          send(res, result.ok ? 200 : 502, result);
          return;
        }

        // 浏览器端把"命令注册诊断"回报上来：于是不开浏览器也能从 status 读到失败原因。
        if (action === 'diag') {
          const payload = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
          state.clientDiag = { ...payload, receivedAt: new Date().toISOString() };
          send(res, 200, { ok: true });
          return;
        }

        send(res, 404, { error: `未知接口 ${action}` });
      } catch (error) {
        send(res, 400, { error: String(error?.message ?? error) });
      }
    }
  };
}