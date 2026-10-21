// 换 npm 作用域/包名：一条命令改掉全仓库所有引用。
//
// 为什么需要它：**npm 的作用域必须等于你的 npm 用户名**。GitHub 叫 HouRIVERrain 不代表
// npm 用户名也是它；作用域对不上时 `npm publish` 会直接 403。
//
// 用法：
//   node scripts/set-npm-scope.mjs --scope houriverrain --dry   # 只预览，不改
//   node scripts/set-npm-scope.mjs --scope yourname             # 真改
//   node scripts/set-npm-scope.mjs --name dsh-media-tools       # 改成非作用域名（可选）
//
// 改完记得重跑一次安装，让 junction 与 profile patch 跟上：
//   node scripts/link-install.mjs desktop
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const dry = argv.includes('--dry') || argv.includes('--dry-run');
const scopeIndex = argv.indexOf('--scope');
const nameIndex = argv.indexOf('--name');
const scope = scopeIndex >= 0 ? argv[scopeIndex + 1] : '';
const bare = nameIndex >= 0 ? argv[nameIndex + 1] : '';

const PLUGIN_DIR = path.resolve(import.meta.dirname, '..');
const manifestFile = path.join(PLUGIN_DIR, 'package.json');
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
const OLD = String(manifest.name);
const FLAT = OLD.replace(/^@[^/]+\//, '');

const NEW = bare ? bare : (scope ? `@${scope.toLowerCase()}/${FLAT}` : '');
if (!NEW) {
  console.error('用法：node scripts/set-npm-scope.mjs --scope <你的npm用户名> [--dry]');
  console.error('  或：node scripts/set-npm-scope.mjs --name <包名> [--dry]');
  process.exit(1);
}
if (!/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(NEW)) {
  console.error(`包名不合法（npm 要求小写）：${NEW}`);
  process.exit(1);
}
if (NEW === OLD) {
  console.log(`包名已经是 ${NEW}，无需改动。`);
  process.exit(0);
}

// 要改的文件与其替换规则。README 里的 npm 徽章 URL 也要跟着换（用 URL 编码形式）。
const npmBadgeOld = `https://img.shields.io/npm/v/${encodeURIComponent(OLD).replace('%2F', '%2F')}`;
const npmBadgeNew = `https://img.shields.io/npm/v/${encodeURIComponent(NEW)}`;
const targets = [
  { file: 'package.json', subs: [[`"name": "${OLD}"`, `"name": "${NEW}"`]] },
  { file: 'cordis.patch.yml', subs: [[`name: '${OLD}'`, `name: '${NEW}'`], [`name: ${OLD}`, `name: ${NEW}`]] },
  // ⚠️ 这一条是血泪换来的：客户端 bundle 里 __ModuleLoader__.load({ id }) 必须与包名一致。
  // 漏改它会 → client-modules 失效逻辑对不上 → 同一 bundle 注册两次 → 未捕获异常 →
  // DSH 启动失败并把 profile 重置成"无插件"（实测事故，2026-10-21）。
  { file: 'lib/client.js', subs: [[`const BUNDLE_ID = '${OLD}'`, `const BUNDLE_ID = '${NEW}'`]] },
  { file: 'README.md', subs: [[OLD, NEW], [npmBadgeOld, npmBadgeNew]] },
  { file: 'README.zh.md', subs: [[OLD, NEW], [npmBadgeOld, npmBadgeNew]] },
  { file: 'CHANGELOG.md', subs: [[OLD, NEW]] },
  { file: 'SECURITY.md', subs: [[OLD, NEW]] }
];

let totalEdits = 0;
for (const { file, subs } of targets) {
  const full = path.join(PLUGIN_DIR, file);
  if (!fs.existsSync(full)) { console.log(`跳过（不存在）：${file}`); continue; }
  let text = fs.readFileSync(full, 'utf8');
  const before = text;
  let edits = 0;
  for (const [from, to] of subs) {
    if (from === to) continue;
    const parts = text.split(from);
    if (parts.length > 1) { edits += parts.length - 1; text = parts.join(to); }
  }
  if (text !== before) {
    totalEdits += edits;
    console.log(`${dry ? '[预览] ' : ''}${file}：${edits} 处`);
    if (!dry) fs.writeFileSync(full, text, 'utf8');
  } else {
    console.log(`${file}：无需改动`);
  }
}

console.log(`\n${dry ? '（预览模式，未写入）' : '已完成'}：${OLD} → ${NEW}，共 ${totalEdits} 处`);
if (!dry) {
  console.log('\n下一步：');
  console.log('  1) node scripts/link-install.mjs desktop     # 让 junction、profile dependencies、patch 的 name 跟上');
  console.log('  2) git add -A && git commit -m "chore: rename npm package"');
}
if (NEW.startsWith('@')) {
  console.log(`\n提示：作用域 ${NEW.split('/')[0]} 必须与你的 npm 用户名一致，否则 npm publish 会 403。`);
  console.log('      用 `npm whoami` 确认当前登录的用户名。');
}