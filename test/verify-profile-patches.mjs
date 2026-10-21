// 重启 DSH 之前的静态安全校验：写坏 profile 的 cordis.patch.yml 会让 DSH 起不来。
//
// 这个脚本**不依赖任何第三方包**（不用 YAML 库）：只用正则回答四个真问题 ——
//   ① profile patch 还能读、结构没被破坏（顶层 `- ` 行数与前几条 id 打印出来给人看）
//   ② 插件自带的 patch 里 entry 的 id / name 与 package.json 一致（不一致 → 加载器解析不到模块）
//   ③ profile 的 package.json 与 node_modules 链接链路完好（能解析到 lib/index.js）
//   ④ profile patch 里**没有明文 apiKey**（有就警告并给出迁移命令）
//
// 用法：node test/verify-profile-patches.mjs [profile]      默认 desktop
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PLUGIN_DIR = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'package.json'), 'utf8'));
const NAME = String(manifest.name);
const FLAT_NAME = NAME.replace(/^@[^/]+\//, '');
const ID = 'media-gen'; // 必须等于插件注册的设置命名空间名
const DSH = path.join(os.homedir(), '.dsh');
const PROFILE = process.argv[2] || 'desktop';
const PROFILE_DIR = path.join(DSH, 'profiles', PROFILE);

const problems = [];
const warn = (m) => { problems.push(m); console.log(`  ⚠️ ${m}`); };
const ok = (m) => console.log(`  ✓ ${m}`);
const read = (file) => fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');

// ── ① 插件自带的 patch ────────────────────────────────────────────────────
console.log(`① 插件自带 patch：cordis.patch.yml`);
const patchRel = manifest?.dsh?.bundle?.patch;
if (!patchRel) { problems.push('package.json 缺少 dsh.bundle.patch'); }
else {
  const text = read(path.join(PLUGIN_DIR, patchRel));
  const idLines = [...text.matchAll(/^\s*-\s*id:\s*([\w-]+)\s*$/gm)].map((m) => m[1]);
  const nameLines = [...text.matchAll(/^\s*name:\s*['"]?([^'"\s]+)['"]?\s*$/gm)].map((m) => m[1]);
  if (!idLines.includes(ID)) problems.push(`patch 里没有 id: ${ID} 的 entry（设置命名空间不同名则设置页写不进去）`);
  else ok(`entry id = ${ID}`);
  if (!nameLines.includes(NAME)) problems.push(`patch 里的 name 必须等于包名 ${NAME}（当前：${nameLines.join(', ') || '（无）'}）`);
  else ok(`entry name = ${NAME}`);
}

// ── ② profile patch 结构 + 明文密钥 ──────────────────────────────────────
console.log(`② profile patch：${path.join(PROFILE_DIR, 'cordis.patch.yml')}`);
const profilePatch = path.join(PROFILE_DIR, 'cordis.patch.yml');
if (!fs.existsSync(profilePatch)) {
  console.log('  （该 profile 没有 patch 文件，跳过）');
} else {
  const text = read(profilePatch);
  const rows = [...text.matchAll(/^-\s*(?:id|insert|disabled):\s*([\w-]*)/gm)].map((m) => m[1] || 'insert');
  const ids = [...text.matchAll(/^\s*-\s*id:\s*([\w-]+)\s*$/gm)].map((m) => m[1]);
  ok(`顶层操作 ${rows.length} 条；定向 id：${ids.join(', ') || '（无）'}`);
  if (!rows.length) problems.push('patch 里没有任何顶层 `- ` 操作，结构可能已损坏');

  // 明文 apiKey：只认 media-gen 那一行之后、下一条顶层行之前的 apiKey
  const lines = text.split(/\r?\n/);
  const rowAt = lines.findIndex((l) => /^-\s*id:\s*media-gen\s*$/.test(l));
  if (rowAt >= 0) {
    for (let i = rowAt + 1; i < lines.length && !/^-\s/.test(lines[i]); i += 1) {
      if (/^\s*apiKey:\s*\S/.test(lines[i])) {
        warn(`profile patch 第 ${i + 1} 行有**明文 apiKey**：建议跑 npm run migrate:key -- --remove --profile ${PROFILE} 搬进插件存储`);
      }
    }
  }
}

// ── ③ profile 登记与链接链路 ─────────────────────────────────────────────
console.log(`③ profile 登记：${path.join(PROFILE_DIR, 'package.json')}`);
const pkgFile = path.join(PROFILE_DIR, 'package.json');
if (!fs.existsSync(pkgFile)) {
  console.log('  （没有 package.json，跳过：该 profile 可能用的是别的安装方式）');
} else {
  const pkg = JSON.parse(read(pkgFile));
  const bundles = pkg?.dsh?.profile?.bundles ?? [];
  if (!bundles.includes(NAME)) problems.push(`dsh.profile.bundles 里没有 ${NAME}（插件不会被加载）`);
  else ok(`bundles 含 ${NAME}（共 ${bundles.length} 条）`);
  const dep = pkg?.dependencies?.[NAME];
  if (!dep) warn(`dependencies 里没有 ${NAME}；若你用 dsh plugin 安装的，这属于异常`);
  else ok(`dependencies.${NAME} = ${dep}`);

  const target = path.join(PROFILE_DIR, 'node_modules', ...NAME.split('/'));
  try {
    const real = fs.realpathSync(target);
    if (!fs.existsSync(path.join(real, 'lib', 'index.js'))) problems.push(`${target} 解析到的目录里没有 lib/index.js`);
    else ok(`链接可解析：${target} → ${real}`);
  } catch (error) {
    problems.push(`profile 的 node_modules 里解析不到 ${NAME}：${error.message}`);
  }
}

// ── 结论 ─────────────────────────────────────────────────────────────────
console.log('');
if (problems.length) {
  console.error(`❌ 发现 ${problems.length} 个问题，先修好再重启 DSH：`);
  for (const p of problems) console.error(`   · ${p}`);
  process.exit(1);
}
console.log(`✅ profile「${PROFILE}」的 patch、登记与链接链路全部校验通过（可以安全重启 DSH）`);