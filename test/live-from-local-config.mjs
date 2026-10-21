// 用「插件自己会用的那把 key」跑联网测试 —— 只读取，绝不打印密钥。
//
// key 来源顺序与插件一致（见 lib/config.js 的 resolveApiKey）：
//   1. 环境变量 DSH_MEDIA_API_KEY
//   2. 插件自有存储 ~/.dsh/storages/media-gen/settings.json（设置页写入的那份）
//   3. profile patch 里 media-gen 覆盖行的 config.apiKey（明文，最不推荐；用正则取，不引入 YAML 依赖）
//
// 用法：node test/live-with-local-key.mjs [--live] [--live-video] [--profile desktop]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ENV_NAME = 'DSH_MEDIA_API_KEY';
const argv = process.argv.slice(2);
const profileIndex = argv.indexOf('--profile');
const PROFILE = profileIndex >= 0 ? argv[profileIndex + 1] : 'desktop';
const DSH = path.join(os.homedir(), '.dsh');

function fromEnv() {
  return String(process.env[ENV_NAME] ?? '').trim();
}

function fromStore() {
  try {
    const file = path.join(DSH, 'storages', 'media-gen', 'settings.json');
    return String(JSON.parse(fs.readFileSync(file, 'utf8'))?.apiKey ?? '').trim();
  } catch { return ''; }
}

/** 只在 media-gen 那一行之后、下一条顶层 `- ` 之前找 apiKey（不碰别的插件）。 */
function fromProfilePatch() {
  try {
    const file = path.join(DSH, 'profiles', PROFILE, 'cordis.patch.yml');
    const lines = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
    let row = -1;
    for (let i = 0; i < lines.length; i += 1) {
      if (/^-\s*id:\s*media-gen\s*$/.test(lines[i])) { row = i; break; }
    }
    if (row < 0) return '';
    for (let i = row + 1; i < lines.length && !/^-\s/.test(lines[i]); i += 1) {
      const m = /^\s*apiKey:\s*(.+?)\s*$/.exec(lines[i]);
      if (m) return m[1].replace(/^['"]|['"]$/g, '').trim();
    }
    return '';
  } catch { return ''; }
}

const sources = [
  ['环境变量 ' + ENV_NAME, fromEnv()],
  ['插件存储 settings.json', fromStore()],
  [`profile patch（${PROFILE}）`, fromProfilePatch()]
];
const hit = sources.find(([, value]) => value);
if (!hit) {
  console.error('没有找到可用的 key。请任选一种方式提供：');
  console.error(`  · 设置环境变量 ${ENV_NAME}`);
  console.error('  · 在「设置 → 生图 / 生视频」里填一次（写入插件存储）');
  console.error('  · 或在 profile patch 的 media-gen 行里填 config.apiKey（明文，最不推荐）');
  process.exit(1);
}

process.env[ENV_NAME] = hit[1];
// 透传调用方给的开关；没给就默认只跑生图那一段（省钱）。
const flags = argv.filter((a) => a.startsWith('--') && a !== '--profile' && a !== PROFILE);
process.argv = [process.argv[0], process.argv[1], ...(flags.length ? flags : ['--live'])];
console.log(`[live] 已注入 key（长度 ${hit[1].length}，来源：${hit[0]}，不回显）；开关：${flags.join(' ') || '--live'}`);
await import('./smoke.mjs');