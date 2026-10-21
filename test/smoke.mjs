// 离线冒烟测试：用假 ctx 装配插件，校验注册与参数契约，不联网、不花钱。
//
//   node test/smoke.mjs                  # 只跑离线断言
//   node test/smoke.mjs --live           # 额外真出 1 张图（需要 key，会花钱）
//   node test/smoke.mjs --live-video     # 额外真出 1 段视频（需要 key，1~7 分钟，会花钱）
//
// key 来源与插件运行时一致：DSH_MEDIA_API_KEY 环境变量，或 config 直填。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { apply, name, Config } from '../lib/index.js';
import { TOOL_NAMES } from '../lib/tools.js';

const live = process.argv.includes('--live');
const liveVideo = process.argv.includes('--live-video');
const KEY_ENV = 'DSH_MEDIA_API_KEY';
const key = (process.env[KEY_ENV] || '').trim();

console.log(`插件名: ${name}`);
console.log(`Config schema: ${Config ? '已导出（设置页会渲染表单）' : '未导出（缺 schemastery，表单不可用）'}`);

// 设置页表单的契约：只有 volatile 字段会渲染；apiKey 必须是 role('secret')。
if (Config) {
  const dict = Config.dict ?? {};
  const keys = Object.keys(dict);
  const volatileKeys = keys.filter((k) => dict[k]?.meta?.volatile === true);
  const secretKeys = keys.filter((k) => dict[k]?.meta?.role === 'secret');
  console.log(`  字段 ${keys.length} 个，其中 volatile（进表单）${volatileKeys.length} 个`);
  console.log(`  secret 字段: ${secretKeys.join(', ') || '（无）'}`);
  assert.ok(keys.length >= 10, 'Config 字段数偏少');
  assert.ok(volatileKeys.length >= keys.length - 1, '除 secret 外所有字段都应带 volatile，否则设置页看不到');
  assert.deepEqual(secretKeys, ['apiKey'], 'apiKey 必须是唯一的 secret 字段');
}

const registered = [];
const routes = [];
const mockCtx = {
  tools: {
    register(definition) {
      registered.push(definition);
      return () => {};
    }
  },
  // 假装宿主有 webserver：验证宿主 HTTP 接口真的被注册（浏览器设置页 / 命令弹窗靠它）。
  webServer: {
    register(route) {
      routes.push(route);
      return () => {};
    }
  },
  logger: { warn: (m) => console.log('  [warn]', m) },
  // 真实宿主里 webServer 是经注入拿到的（官方 dsh-client-hmr: inject = ["clientModules","webServer"]）。
  // 模拟 cordis 的惰性注入回调，确保这条路径被测到——上一版就是因为漏了注入而静默 404。
  inject(deps, callback) {
    callback({ webServer: mockCtx.webServer });
  },
  on() {}
};

const api = apply(mockCtx, { apiKey: key, autoDiscover: false });
const names = await api.ready;

console.log(`\n注册工具 ${registered.length} 个: ${names.join(', ')}`);
assert.deepEqual([...names].sort(), [...TOOL_NAMES].sort(), '注册的工具集必须与 TOOL_NAMES 一致');

for (const tool of registered) {
  assert.equal(typeof tool.name, 'string');
  assert.equal(typeof tool.description, 'string');
  assert.equal(typeof tool.parameters, 'object');
  assert.ok(tool.parameters.type === 'object', `${tool.name} 的参数必须是 object schema`);
  const required = tool.parameters.required ?? [];
  console.log(`  · ${tool.name.padEnd(18)} 参数: ${Object.keys(tool.parameters.properties ?? {}).join(', ') || '（无）'}${required.length ? `  必填: ${required.join(',')}` : ''}`);
}

// 宿主 HTTP 接口应已注册（设置页的填 key / 选模型都靠它）。
assert.equal(routes.length, 1, '必须注册恰好一条宿主 HTTP 路由');
assert.equal(routes[0].path, '/dsh-media-gen', '路由前缀必须是 /dsh-media-gen（带尾斜杠会让前缀匹配失效）');
assert.equal(typeof routes[0].handler, 'function');
assert.equal(api.state.webRoute, 'registered', 'webServer 惰性注入路径必须真的注册成功（漏注入会在这里挂）');
console.log(`  宿主 HTTP 接口: ${routes[0].path}（${routes[0].kind}，状态 ${api.state.webRoute}）`);

// 图片工具必须有 image 内容块的能力（官方通道下经 createMcpToolDefinition 投影）
const imageTool = registered.find((t) => t.name === 'media_gen_image');
assert.ok(imageTool, 'media_gen_image 必须注册');
assert.ok(imageTool.parameters.properties.prompt, 'media_gen_image 必须有 prompt');

// 状态工具在无 key 时必须给出可操作的错误，而不是抛栈
const status = await api.run('media_status', {}, undefined);
const statusText = status.content[0].text;
assert.ok(/keySource/.test(statusText), 'media_status 必须报告 key 来源');
console.log(`\nmedia_status（无 key 场景）:\n${statusText}`);

// 无 key 的行为只在真的没有 key 时断言。注意 key 现在还有第三个来源：插件自有存储
// （~/.dsh/storages/media-gen/settings.json，由设置页写入），所以这里要一并检查。
const { storeView } = await import('../lib/store.js');
const storeKey = storeView();
if (key || storeKey.keySet) {
  console.log(`\n（检测到可用 key：env=${key ? '有' : '无'}，store=${storeKey.keySet ? `有(${storeKey.keyHint})` : '无'}，跳过“无 key 断言”）`);
} else {
  const noKey = await api.run('media_gen_image', { prompt: '测试' }, undefined);
  assert.equal(noKey.isError, true, '无 key 时出图必须返回 isError 而不是抛异常');
  assert.ok(/API Key/.test(noKey.content[0].text), '无 key 的错误必须告诉用户去哪儿填');
  console.log(`\n无 key 出图的报错（应给出可操作指引）:\n${noKey.content[0].text}`);
}

if (live || liveVideo) {
  if (!key && !storeKey.keySet) {
    console.log(`\n⚠️ 跳过联网测试：既没有 ${KEY_ENV}，插件存储里也没有 key`);
  } else {
    console.log('\n── 联网探测模型 ──');
    const listed = await api.run('media_list_models', { kind: 'all', force: true }, undefined);
    const text = listed.content[0].text;
    console.log(text.split('\n').slice(0, 12).join('\n') + '\n…');
    assert.ok(!listed.isError, '模型探测不应失败');

    if (live) {
      console.log('\n── 真出 1 张图 ──');
      const img = await api.run('media_gen_image', { prompt: '一只戴耳机的橘猫坐在显示器前，扁平插画风格', size: '1:1' }, undefined);
      assert.ok(!img.isError, '出图不应失败: ' + img.content[0].text);
      const meta = JSON.parse(img.content[0].text);
      console.log(`file=${meta.file}\nbytes=${meta.bytes} model=${meta.model} ms=${meta.ms}`);
      assert.ok(fs.existsSync(meta.file), '图片文件必须落盘');
      console.log(`内联图片块: ${img.content.some((b) => b.type === 'image') ? '有' : '无（退化通道）'}`);
    }

    if (liveVideo) {
      console.log('\n── 真出 1 段视频（可能要几分钟）──');
      const vid = await api.run('media_gen_video', { prompt: '一只橘猫在窗台上伸懒腰，阳光斜照，镜头缓慢推近', ratio: '16:9' }, undefined);
      assert.ok(!vid.isError, '出视频不应失败: ' + vid.content[0].text);
      const meta = JSON.parse(vid.content[0].text);
      console.log(`file=${meta.file}\nbytes=${meta.bytes} model=${meta.model} taskId=${meta.taskId} ms=${meta.ms}`);
      assert.ok(fs.existsSync(meta.file), '视频文件必须落盘');
    }
  }
}

console.log('\n✅ 离线断言全部通过');