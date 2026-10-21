// 媒体能力核心：模型探测（两套面）、生图、生视频。
//
// 本文件是自包含的：不依赖仓库里的任何其它脚本，装了插件就能用。协议细节都是 2026-10-21 在
// 千问 MaaS 上实测出来的（见 README 的“实测记录”）：
//
//   · 生图：OpenAI 兼容面 POST {imageBaseUrl}/images/generations
//           { model, prompt, size } —— size 必须像素写法（"1:1" 会 400），
//           返回同步结果 data[0].url（带签名的 OSS 链接，必须即时下载）。
//   · 生视频：native DashScope 面
//           POST {videoBaseUrl}/services/aigc/video-generation/video-synthesis
//           头必须带 X-DashScope-Async: enable，体 { model, input:{prompt}, parameters }，
//           parameters 的尺寸字段**因模型而异**：MiniMax-H3 只认 ratio（且不能 adaptive），
//           wan 系认 size（1280*720）。本模块对 H3 走 ratio、对其它走 size，并允许调用方覆盖。
//           轮询 GET {videoBaseUrl}/tasks/{task_id} → output.task_status / output.video_url。
//   · 兼容面上**没有** /videos 路由（实测 404 空 body），视频模型只出现在 native 目录里
//     （兼容面 178 个模型无一个视频；native 356 个里视频类 88 个）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const IMAGE_MODEL_RE = /image|flux|sd[0-9]|dall|seedream|kolors|nano-banana|qwen-image|gpt-image|z-image|wan[0-9.]*-image/i;
const VIDEO_MODEL_RE = /t2v|i2v|r2v|kf2v|s2v|video|h3|hailuo|kling|vidu|sora|veo|pixverse|happyhorse|animate|motion|videoretalk/i;

/**
 * 实测可用的生图模型（2026-10-21 于千问 MaaS，逐个真跑过）。
 *
 * 为什么需要这个清单：`GET /models` 列出的模型**不等于**在 `/images/generations` 上可用。
 * 该 key 下 12 个生图模型的实际结果：
 *   ✅ qwen-image-3.0（1.42MB/47s）、qwen-image-3.0-pro（1.55MB/46s）、qwen-image-2.1-pro（1.75MB/19s）
 *   ❌ 400 `url error, please check url！`：wan2.7-image、qwen-image-2.0、qwen-image-2.0-2026-03-03
 *   ❌ 404 空 body：z-image-turbo
 * 所以“自动挑选”与“失败回退”都以实测可用的模型优先，避免用户点名一个只会 400/404 的模型。
 */
export const VERIFIED_IMAGE_MODELS = ['qwen-image-3.0', 'qwen-image-2.1-pro', 'qwen-image-3.0-pro'];

let cache = { at: 0, key: '', image: [], video: [], error: null };

function cacheFile() {
  return path.join(os.homedir(), '.dsh', 'storages', 'media-gen', 'catalog.json');
}

function readCacheFromDisk() {
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
    if (raw && Array.isArray(raw.image) && Array.isArray(raw.video)) return raw;
  } catch {}
  return null;
}

function writeCacheToDisk(value) {
  try {
    fs.mkdirSync(path.dirname(cacheFile()), { recursive: true });
    fs.writeFileSync(cacheFile(), JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  } catch {}
}

/** 拒绝内网/本机地址，只允许 https 下载（防 SSRF 与本地文件探测）。 */
export function assertPublicHttps(url) {
  let u;
  try { u = new URL(String(url)); } catch { throw new Error('返回值里的媒体地址不合法'); }
  if (u.protocol !== 'https:') throw new Error('只允许 https 媒体地址');
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host.endsWith('.local')
    || /^(10|127)\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    || /^169\.254\./.test(host) || /^\[?::1\]?$/.test(host)) {
    throw new Error('拒绝下载内网地址');
  }
  return u;
}

async function download(url, timeoutMs, maxBytes) {
  const u = assertPublicHttps(url);
  const res = await fetch(u, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new Error(`媒体超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限`);
  return buf;
}

/** 产物落盘：先试指定目录（须在工作区内），再试默认目录，逐个试并报回真正用到的。 */
export function saveBuffer(buf, { dirs, filename, requestedDir, workspace }) {
  const candidates = [];
  if (requestedDir) {
    const abs = path.resolve(requestedDir);
    const root = workspace ? path.resolve(workspace) : null;
    if (root && abs !== root && !abs.startsWith(root + path.sep)) {
      throw new Error(`outputDir 必须位于工作区内：${root}`);
    }
    candidates.push(abs);
  }
  candidates.push(...dirs);
  const errors = [];
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, filename);
      fs.writeFileSync(file, buf);
      return { file, dir };
    } catch (error) {
      errors.push(`${dir}: ${error?.code ?? error?.message ?? error}`);
    }
  }
  throw new Error(`所有目录都写不进去（${errors.join(' | ')}）`);
}

function slug(text, max = 40) {
  return String(text || '').replace(/\s+/g, '-').replace(/[^\w\u4e00-\u9fa5.-]/g, '').slice(0, max) || 'media';
}

export function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

export const mediaSlug = slug;

// ── 模型探测 ────────────────────────────────────────────────────────────────

/**
 * 从 OpenAI 兼容面拉生图模型。
 * 实测：GET {base}/models → { object:'list', data:[{id}] }（178 个，其中图像类 12 个）。
 */
export async function listImageModels(cfg, key) {
  const res = await fetch(`${cfg.imageBaseUrl}/models`, {
    headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30000)
  });
  if (!res.ok) throw new Error(`拉取生图模型清单失败 HTTP ${res.status}`);
  const body = await res.json().catch(() => null);
  const rows = Array.isArray(body) ? body : (body?.data ?? body?.models ?? body?.list ?? []);
  const ids = rows.map((m) => (typeof m === 'string' ? m : (m.id ?? m.model ?? m.name ?? ''))).filter(Boolean);
  return ids.filter((id) => IMAGE_MODEL_RE.test(id));
}

/**
 * 从 native DashScope 面拉生视频模型。
 * 实测：GET {base}/models?page_no=&page_size= → { output:{ models:[{model, name, prices, capabilities}] } }，
 * 共 356 条、视频类 88 条。分页拉到不足一页为止。
 */
export async function listVideoModels(cfg, key) {
  const all = [];
  for (let page = 1; page <= 8; page += 1) {
    const res = await fetch(`${cfg.videoBaseUrl}/models?page_no=${page}&page_size=100`, {
      headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30000)
    });
    if (!res.ok) throw new Error(`拉取生视频模型清单失败 HTTP ${res.status}`);
    const body = await res.json().catch(() => null);
    const rows = body?.output?.models ?? body?.data ?? [];
    if (!rows.length) break;
    for (const m of rows) all.push(typeof m === 'string' ? m : (m.model ?? m.id ?? m.name ?? ''));
    if (rows.length < 100) break;
  }
  return all.filter((id) => id && VIDEO_MODEL_RE.test(id));
}

/**
 * 探测并按 TTL 缓存。cacheKey 用 baseUrl+key 的指纹，避免换 key 后吃到旧目录。
 * 结果同时落盘（0600），进程重启后仍能秒回。
 */
export async function discoverModels(cfg, key, { force = false } = {}) {
  const fingerprint = `${cfg.imageBaseUrl}|${cfg.videoBaseUrl}|${key ? key.slice(-6) : ''}`;
  const disk = cache.at === 0 ? readCacheFromDisk() : null;
  if (!force && disk && disk.key === fingerprint && Date.now() - disk.at < cfg.catalogTtlMs) {
    cache = { at: disk.at, key: disk.key, image: disk.image, video: disk.video, error: null };
  }
  if (!force && cache.key === fingerprint && cache.image.length + cache.video.length > 0
      && Date.now() - cache.at < cfg.catalogTtlMs) {
    return cache;
  }

  const next = { at: Date.now(), key: fingerprint, image: [], video: [], error: null };
  // 失败那一面要保留上一次的清单：原生目录端点会偶发 HTTP 429（实测遇到过），
  // 如果直接写成空数组，一次限流就会把 88 个生视频模型从界面和缓存里抹掉。
  const previous = (cache.key === fingerprint ? cache : null)
    ?? (disk && disk.key === fingerprint ? disk : null)
    ?? (cache.image.length || cache.video.length ? cache : null);
  const failures = [];
  try { next.image = await listImageModels(cfg, key); }
  catch (e) { failures.push(`生图：${e.message}`); next.image = previous?.image ?? []; }
  try { next.video = await listVideoModels(cfg, key); }
  catch (e) { failures.push(`生视频：${e.message}`); next.video = previous?.video ?? []; }
  if (failures.length) {
    next.error = failures.join(' | ');
    if (previous && (next.image.length || next.video.length)) {
      next.error += '（已保留上一次成功探测到的清单，可稍后重试）';
    }
  }
  if (next.image.length || next.video.length) writeCacheToDisk(next);
  cache = next;
  return next;
}

export function cachedCatalog() {
  return cache;
}

export function resetCache() {
  cache = { at: 0, key: '', image: [], video: [], error: null };
}

/** 目录摘要（给设置页的只读字段与 media_status 用，不泄露 key）。 */
export function summarize(catalog) {
  const head = (list, n = 6) => list.slice(0, n).join(', ') + (list.length > n ? ` …（共 ${list.length}）` : '');
  return `生图 ${catalog.image.length} 个：${head(catalog.image)}\n生视频 ${catalog.video.length} 个：${head(catalog.video)}`;
}

// ── 生图 ────────────────────────────────────────────────────────────────────

/**
 * 生成一张图，返回 { buffer, model, ms, sourceUrl }。
 * size 归一：本平台只认 WxH 像素；写比例（1:1 / 16:9）就折算成像素。
 */
export async function generateImage(cfg, key, { prompt, size, model }) {
  const started = Date.now();
  const pickedModel = String(model || cfg.imageModel || '').trim();
  if (!pickedModel) throw new Error('没有可用的生图模型：请在设置里填 imageModel，或先跑 media_list_models 探测');

  const body = { model: pickedModel, prompt: String(prompt), n: 1, size: toPixelSize(size || cfg.imageSize) };
  const res = await fetch(`${cfg.imageBaseUrl}/images/generations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180000)
  });
  const raw = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch {}
  if (!res.ok) {
    const detail = parsed?.error?.message ?? parsed?.message ?? raw.replace(/\s+/g, ' ').slice(0, 300);
    // “模型不可用”与“鉴权/限流”要分开：前者换模型有意义，后者换模型没意义。
    const unavailable = res.status === 404
      || (res.status === 400 && /url error|model not|not exist|unsupported|invalid model/i.test(String(detail)));
    const e = new Error(`生图失败（model=${pickedModel}, HTTP ${res.status}）：${detail || '无返回体'}`);
    e.code = res.status;
    e.modelUnavailable = unavailable;
    if (unavailable) {
      e.message += `\n提示：模型清单里有 ≠ 该端点能用。本 key 实测可用的是 ${VERIFIED_IMAGE_MODELS.join(' / ')}。`;
    }
    throw e;
  }

  const first = parsed?.data?.[0] ?? parsed?.images?.[0] ?? null;
  const b64 = first?.b64_json ?? first?.b64 ?? null;
  const url = first?.url ?? (typeof first === 'string' ? first : null) ?? parsed?.url ?? null;
  let buffer;
  if (b64) buffer = Buffer.from(String(b64), 'base64');
  else if (url) buffer = await download(url, 180000, cfg.maxDownloadBytes);
  else throw new Error('接口成功但没找到图片（data[0].url / b64_json 都没有）：' + raw.replace(/\s+/g, ' ').slice(0, 200));

  return { buffer, model: pickedModel, ms: Date.now() - started, sourceUrl: url ?? null };
}

/** 比例/像素归一：能解析成 WxH 就原样，比例则折算成常见像素。 */
export function toPixelSize(size) {
  const raw = String(size ?? '').trim();
  if (!raw) return '1024x1024';
  const px = /^(\d+)\s*[x*×]\s*(\d+)$/i.exec(raw);
  if (px) return `${Number(px[1])}x${Number(px[2])}`;
  const table = { '1:1': '1024x1024', '16:9': '1280x720', '9:16': '720x1280', '4:3': '1152x864', '3:4': '864x1152' };
  return table[raw] ?? '1024x1024';
}

// ── 生视频 ──────────────────────────────────────────────────────────────────

/** 视频模型的参数形状：H3 这类只认 ratio，wan 系认 size。 */
function videoParameters(cfg, { model, ratio, size }) {
  const isRatioStyle = /minimax|hailuo|h3|kling|vidu|pixverse|happyhorse/i.test(String(model ?? ''));
  if (isRatioStyle) {
    const r = String(ratio || cfg.videoRatio || '16:9').trim();
    return { style: 'ratio', params: { ratio: /^\d+\s*:\s*\d+$/.test(r) ? r : '16:9' } };
  }
  const s = String(size || '').trim();
  return { style: 'size', params: s ? { size: s } : {} };
}

/**
 * 提交 + 轮询 + 下载，返回 { buffer, model, taskId, ms, params, style, log }。
 * onTick(line) 可以把进度喂给调用方（工具里拼进返回值）。
 */
export async function generateVideo(cfg, key, { prompt, model, ratio, size, seconds, imageUrl, onTick }) {
  const started = Date.now();
  const pickedModel = String(model || cfg.videoModel || '').trim();
  if (!pickedModel) throw new Error('没有可用的生视频模型：请在设置里填 videoModel，或先跑 media_list_models 探测');

  const { style, params } = videoParameters(cfg, { model: pickedModel, ratio, size });
  const parameterObject = { ...params };
  const secs = Number(seconds ?? cfg.videoSeconds) || 0;
  if (secs > 0) parameterObject.duration = secs;

  const input = { prompt: String(prompt) };
  if (imageUrl) input.img_url = String(imageUrl);

  const res = await fetch(`${cfg.videoBaseUrl}/services/aigc/video-generation/video-synthesis`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'X-DashScope-Async': 'enable'
    },
    body: JSON.stringify({ model: pickedModel, input, parameters: parameterObject }),
    signal: AbortSignal.timeout(120000)
  });
  const raw = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch {}
  const taskId = parsed?.output?.task_id ?? parsed?.output?.taskId ?? null;
  if (!taskId) {
    const detail = parsed?.message ?? parsed?.output?.message ?? parsed?.output?.code ?? raw.replace(/\s+/g, ' ').slice(0, 300);
    const e = new Error(`提交视频任务失败（model=${pickedModel}, HTTP ${res.status}）：${detail || '无返回体'}`);
    e.code = res.status;
    e.detail = String(detail ?? '');
    throw e;
  }

  const log = [];
  const deadline = Date.now() + cfg.videoTimeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, cfg.pollIntervalMs));
    let info = null;
    try {
      const r = await fetch(`${cfg.videoBaseUrl}/tasks/${encodeURIComponent(taskId)}`, {
        headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30000)
      });
      info = await r.json().catch(() => null);
    } catch (error) {
      onTick?.(`轮询异常：${error?.message ?? error}`);
      continue;
    }
    const status = String(info?.output?.task_status ?? info?.output?.status ?? '');
    const line = `${status}${info?.output?.message ? `  ${info.output.message}` : ''}`;
    if (line !== last) { last = line; log.push(line); onTick?.(line); }
    if (status === 'SUCCEEDED' || status === 'SUCCESS') {
      const url = info?.output?.video_url ?? info?.output?.results?.video_url ?? info?.output?.result_url ?? null;
      if (!url) throw new Error('任务成功但没有 video_url：' + JSON.stringify(info?.output ?? info).slice(0, 300));
      const buffer = await download(url, 240000, cfg.maxDownloadBytes);
      return { buffer, model: pickedModel, taskId, ms: Date.now() - started, params: parameterObject, style, log };
    }
    if (status === 'FAILED' || status === 'UNKNOWN') {
      const e = new Error(`视频任务失败（${status}）：${info?.output?.message ?? JSON.stringify(info?.output ?? info).slice(0, 400)}`);
      e.taskId = taskId;
      throw e;
    }
  }
  const e = new Error(`视频任务超时（${Math.round(cfg.videoTimeoutMs / 1000)} 秒未完成），task_id=${taskId}`);
  e.taskId = taskId;
  e.log = log;
  throw e;
}