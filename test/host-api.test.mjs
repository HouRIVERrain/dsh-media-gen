// 宿主 HTTP 接口 + 设置存储的离线测试。
// 关键：先把 USERPROFILE/HOME 指向临时目录再**动态** import，避免碰到你真实的 ~/.dsh 配置。
// 用法：node test/host-api.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const FAKE_HOME = path.resolve(import.meta.dirname, '..', '..', 'tmp', 'fakehome');
fs.rmSync(FAKE_HOME, { recursive: true, force: true });
fs.mkdirSync(FAKE_HOME, { recursive: true });
process.env.USERPROFILE = FAKE_HOME;
process.env.HOME = FAKE_HOME;

const { storeFile, readStore, writeStore, clearStore, storeView, keyHint } = await import('../lib/store.js');
const { createRouteHandler, ROUTE_PREFIX } = await import('../lib/host-api.js');

console.log(`临时 HOME：${FAKE_HOME}`);
assert.ok(storeFile().startsWith(FAKE_HOME), 'store 文件必须落在临时 HOME 下');

// ── 1. 存储：写入 / 读取 / 只读视图不含密钥 ─────────────────────────────
const SECRET = 'sk-test-abcdef1234567890';
writeStore({ apiKey: SECRET, imageModel: 'qwen-image-3.0', selectedImageModel: 'qwen-image-2.1-pro' });
const view = storeView();
console.log(`storeView: ${JSON.stringify(view)}`);
assert.equal(view.keySet, true, 'keySet 必须为 true');
assert.ok(!JSON.stringify(view).includes(SECRET), '只读视图绝不能包含完整密钥');
assert.ok(view.keyHint.includes('…'), 'hint 必须是掩码形态');
assert.equal(view.selectedImageModel, 'qwen-image-2.1-pro');
assert.equal(keyHint(''), null, '空 key 的 hint 必须是 null');
// Windows 上 POSIX 权限位不生效（chmod 只切只读位），所以只在 POSIX 上断言；
// Windows 的落点仍是用户 profile 下的 ~/.dsh/storages/media-gen/，属尽力而为的隔离。
if (process.platform === 'win32') {
  console.log(`（Windows：跳过 0600 断言，当前 mode=${(fs.statSync(storeFile()).mode & 0o777).toString(8)}）`);
} else {
  assert.equal(fs.statSync(storeFile()).mode & 0o777, 0o600, '存储文件权限必须是 0600');
}

// 白名单：未知字段不得写入
writeStore({ apiKey: SECRET, evil: 'x' });
assert.ok(!Object.hasOwn(readStore(), 'evil'), '未在白名单里的字段必须被忽略');

// ── 2. 路由：真值判定 ─────────────────────────────────────────────────
const calls = [];
const state = {
  cfg: { imageBaseUrl: 'https://example.invalid/compat', videoBaseUrl: 'https://example.invalid/api', imageModel: 'qwen-image-3.0', videoModel: 'MiniMax/MiniMax-H3', videoRatio: '16:9', videoTimeoutMs: 900000, pollIntervalMs: 10000 },
  catalog: { image: ['qwen-image-3.0', 'qwen-image-2.1-pro'], video: ['MiniMax/MiniMax-H3'], error: null, at: Date.now() },
  verifiedImageModels: ['qwen-image-3.0']
};
const handler = createRouteHandler({
  state,
  resolveKey: async () => ({ key: SECRET, source: 'store:settings.json' }),
  ensureCatalog: async ({ force } = {}) => { calls.push(`ensureCatalog:${force}`); return state.catalog; },
  probeEndpoints: async () => ({ ok: true, probes: [{ label: '生图端点', status: 200, ok: true }] })
});
assert.equal(handler.kind, 'prefix');
assert.equal(handler.path, ROUTE_PREFIX);

// 前缀匹配语义的回归测试。官方 dsh-host-webserver（lib/index.js 的 match()）规则是：
//   if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue;
// 注册成带尾斜杠的 '/dsh-media-gen/' 时比较串变成 '/dsh-media-gen//'，
// '/dsh-media-gen/status' 永远匹配不上 —— 真机踩过：register() 不抛错、状态显示"已注册"，
// 但每个请求都 404，极具迷惑性。这条断言就是为了让同类问题下次当场挂掉。
assert.ok(!handler.path.endsWith('/'), '前缀路由路径不能带尾斜杠');
const matches = (pathname) => pathname === handler.path || pathname.startsWith(`${handler.path}/`);
assert.ok(matches('/dsh-media-gen/status'), '/dsh-media-gen/status 必须匹配');
assert.ok(matches('/dsh-media-gen'), '/dsh-media-gen 本身必须匹配');
assert.ok(!matches('/dsh-media-genx'), '不能误匹配 /dsh-media-genx');
assert.ok(!matches('/other'), '不能误匹配别的路径');
console.log(`前缀匹配语义：${handler.path} → 用官方规则复算通过（4 个用例）`);

function fakeReq(method, url, { json, headers = {} } = {}) {
  const body = json === undefined ? '' : JSON.stringify(json);
  return {
    method,
    url,
    headers: { ...(json === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    on(event, cb) {
      if (event === 'data' && body) cb(Buffer.from(body));
      if (event === 'end') cb();
      return this;
    },
    destroy() {}
  };
}

function fakeRes() {
  const out = { status: 0, headers: null, body: '' };
  return {
    out,
    writeHead(status, headers) { out.status = status; out.headers = headers; },
    end(chunk) { out.body = chunk ? String(chunk) : ''; },
    json() { return JSON.parse(out.body); }
  };
}

// 2.1 GET status
{
  const res = fakeRes();
  await handler.handler(fakeReq('GET', `${ROUTE_PREFIX}/status`), res);
  const data = res.json();
  assert.equal(res.out.status, 200);
  assert.equal(data.ready, true);
  assert.equal(data.keySource, 'store:settings.json');
  assert.equal(data.catalog.images.length, 2);
  assert.ok(!res.out.body.includes(SECRET), 'status 响应绝不包含完整密钥');
  assert.ok(data.keyHint.includes('…'), 'status 只给掩码 hint');
  assert.equal(res.out.headers['Cache-Control'], 'no-store');
  console.log(`GET status → 200，ready=${data.ready}，images=${data.catalog.images.length}，keyHint=${data.keyHint}`);
}

// 2.2 POST key 写入
{
  const res = fakeRes();
  await handler.handler(fakeReq('POST', `${ROUTE_PREFIX}/key`, { json: { apiKey: 'sk-live-9f8e7d6c5b4a' } }), res);
  const data = res.json();
  assert.equal(res.out.status, 200);
  assert.equal(data.keySet, true);
  assert.equal(readStore().apiKey, 'sk-live-9f8e7d6c5b4a');
  console.log('POST key → 200（已写入临时 HOME）');
}

// 2.3 缺 JSON content-type → 415（挡跨站表单）
{
  const res = fakeRes();
  await handler.handler(fakeReq('POST', `${ROUTE_PREFIX}/key`), res);
  assert.equal(res.out.status, 415);
  console.log('POST key 无 content-type → 415 ✅');
}

// 2.4 跨站 → 403
{
  const res = fakeRes();
  await handler.handler(fakeReq('POST', `${ROUTE_PREFIX}/key`, { json: { apiKey: 'x' }, headers: { 'sec-fetch-site': 'cross-site' } }), res);
  assert.equal(res.out.status, 403);
  console.log('跨站 POST → 403 ✅');
}

// 2.5 POST select
{
  const res = fakeRes();
  await handler.handler(fakeReq('POST', `${ROUTE_PREFIX}/select`, { json: { kind: 'video', model: 'MiniMax/MiniMax-H3' } }), res);
  assert.equal(res.out.status, 200);
  assert.equal(readStore().selectedVideoModel, 'MiniMax/MiniMax-H3');
  console.log('POST select(video) → 200 ✅');
}

// 2.6 POST models(force) 会走到 ensureCatalog(true)
{
  const res = fakeRes();
  await handler.handler(fakeReq('POST', `${ROUTE_PREFIX}/models`, { json: { force: true } }), res);
  assert.equal(res.out.status, 200);
  assert.ok(calls.includes('ensureCatalog:true'), 'force=true 必须透传给探测');
  console.log(`POST models(force) → 200，探测调用：${calls.join(', ')}`);
}

// 2.6b POST diag：浏览器端回报的命令注册诊断，必须能在 status 里读到
{
  const res = fakeRes();
  await handler.handler(fakeReq('POST', `${ROUTE_PREFIX}/diag`, { json: { attempts: [{ name: 'img', ok: true, stage: 'registered' }], injectFired: true } }), res);
  assert.equal(res.out.status, 200);
  const res2 = fakeRes();
  await handler.handler(fakeReq('GET', `${ROUTE_PREFIX}/status`), res2);
  const diag = res2.json().clientDiag;
  assert.ok(diag && diag.attempts && diag.attempts[0].name === 'img', 'status 必须回传浏览器端诊断');
  assert.ok(diag.receivedAt, '诊断应带接收时间');
  console.log('POST diag → 200，status 能读到 ✅');
}

// 2.7 未知接口 → 404；GET 改状态接口 → 405
{
  const res = fakeRes();
  await handler.handler(fakeReq('GET', `${ROUTE_PREFIX}/nope`), res);
  assert.equal(res.out.status, 404);
  const res2 = fakeRes();
  await handler.handler(fakeReq('GET', `${ROUTE_PREFIX}/key`), res2);
  assert.equal(res2.out.status, 405);
  console.log('未知接口 → 404，GET key → 405 ✅');
}

// ── 3. 清理 ───────────────────────────────────────────────────────────
clearStore();
assert.equal(readStore().apiKey, '', 'clear 之后必须为空');
fs.rmSync(FAKE_HOME, { recursive: true, force: true });
console.log('\n✅ host-api / store 全部断言通过（未触碰真实 ~/.dsh）');