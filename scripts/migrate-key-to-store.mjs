// 把 profile patch 里 media-gen 的明文 apiKey 搬进插件自有存储（~/.dsh/storages/media-gen/settings.json）。
// 搬完 patch 里就只剩一行注释，密钥改由「设置 → 生图 / 生视频」页管理。
//
// 用法：
//   node scripts/migrate-key-to-store.mjs            # 只搬，不改 patch
//   node scripts/migrate-key-to-store.mjs --remove   # 搬完并从 patch 里删掉 apiKey 行
//   node scripts/migrate-key-to-store.mjs --remove --profile desktop
//
// 不依赖任何第三方包：只按行做文本处理，绝不打印密钥内容。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const remove = argv.includes('--remove');
const profileIndex = argv.indexOf('--profile');
const profile = profileIndex >= 0 ? argv[profileIndex + 1] : 'desktop';
const DSH = path.join(os.homedir(), '.dsh');
const patchPath = path.join(DSH, 'profiles', profile, 'cordis.patch.yml');

if (!fs.existsSync(patchPath)) {
  console.error(`找不到 profile patch：${patchPath}`);
  process.exit(1);
}

let text = fs.readFileSync(patchPath, 'utf8').replace(/^\uFEFF/, '');
const lines = text.split(/\r?\n/);

// 只在 media-gen 那一行的 config 块里找 apiKey，避免误伤别的插件。
let rowLine = -1;
for (let i = 0; i < lines.length; i += 1) {
  if (/^-\s*id:\s*media-gen\s*$/.test(lines[i])) { rowLine = i; break; }
}
if (rowLine < 0) {
  console.error('patch 里没有 `- id: media-gen` 的配置块，无需迁移');
  process.exit(1);
}
let keyLine = -1;
for (let i = rowLine + 1; i < lines.length && !/^-\s/.test(lines[i]); i += 1) {
  if (/^\s*apiKey:/.test(lines[i])) { keyLine = i; break; }
}
if (keyLine < 0) {
  console.log('patch 里没有明文 apiKey（可能已经迁过了）');
  process.exit(0);
}

const raw = lines[keyLine].replace(/^\s*apiKey:\s*/, '').trim();
const key = raw.replace(/^['"]|['"]$/g, '');
if (!key) {
  console.error('apiKey 行为空，跳过');
  process.exit(1);
}

// 只写存储，不打印密钥。
const { writeStore, storeFile, storeView } = await import('../lib/store.js');
writeStore({ apiKey: key });
console.log(`已写入插件存储：${storeFile()}`);
console.log(`存储视图（掩码）：${JSON.stringify(storeView())}`);

if (remove) {
  const backup = `${patchPath}.bak-migrate-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(patchPath, backup);
  lines[keyLine] = `${lines[keyLine].match(/^\s*/)[0]}# apiKey 已移入插件存储（设置 → 生图 / 生视频 页管理），见 scripts/migrate-key-to-store.mjs`;
  fs.writeFileSync(patchPath, lines.join('\n'), 'utf8');
  console.log(`已从 patch 删除明文 apiKey 行（第 ${keyLine + 1} 行）`);
  console.log(`patch 备份：${backup}`);
  console.log('插件取 key 顺序：环境变量 → DSH 凭据存储 → 插件存储 → patch config；现在命中的是「插件存储」。');
} else {
  console.log('（未加 --remove：patch 里的明文行仍在；加 --remove 可删掉它）');
}