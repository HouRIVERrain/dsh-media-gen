// 本机手工安装（`dsh` CLI 不在 PATH 时的等价做法）。
//
// DSH 的插件加载靠两件事：
//   ① profile 的 package.json 里 `dependencies` 有它、`dsh.profile.bundles` 列了它；
//   ② 包根能被 Node 解析到（<profile>/node_modules/<包名>，作用域包会落在 @scope/ 子目录下）。
// 两处都做成 junction 指向本仓库，效果与 `dsh plugin add link:<dir>` 物化出的形态一致
// （官方 `dsh plugin add` 在 profile 目录里就是这么落地的）。
//
// 包名一律从 package.json 读，不写死 —— 否则改成作用域包名（@you/dsh-media-gen）后
// 这里的 junction 路径、profile dependencies、patch 里的 name 会三处不一致，插件直接加载不到。
//
// 用法：node scripts/link-install.mjs [profile]     默认 profile = desktop
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DSH_HOME = path.join(os.homedir(), '.dsh');
const PROFILE = process.argv[2] || 'desktop';
const PROFILE_DIR = path.join(DSH_HOME, 'profiles', PROFILE);
/** 历史遗留的非作用域包名：改名后要把它的登记清掉，否则同一个插件会被加载两次。 */
const LEGACY_NAMES = ['dsh-media-gen'];

const log = (m) => console.log(`[link-install] ${m}`);
const fatal = (m) => { console.error(`[link-install] ${m}`); process.exit(1); };

const manifestFile = path.join(PLUGIN_DIR, 'package.json');
if (!fs.existsSync(manifestFile)) fatal(`找不到插件包：${PLUGIN_DIR}`);
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
const NAME = String(manifest.name || '').trim();
if (!NAME) fatal('package.json 缺少 name');
const FLAT_NAME = NAME.replace(/^@[^/]+\//, ''); // 作用域包的扁平名，给 ~/.dsh/plugins 用

if (!fs.existsSync(PROFILE_DIR)) {
  const available = fs.existsSync(path.join(DSH_HOME, 'profiles'))
    ? fs.readdirSync(path.join(DSH_HOME, 'profiles')).filter((n) => !n.startsWith('.')).join(', ')
    : '（无）';
  fatal(`profile 不存在：${PROFILE_DIR}\n可用 profile：${available}`);
}
log(`包名：${NAME}（扁平名 ${FLAT_NAME}）`);

/** 建目录链接（Windows 用 junction，免管理员权限）；已存在且指向本仓库则跳过。 */
function ensureLink(linkPath, targetDir) {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  let existing = null;
  try { existing = fs.lstatSync(linkPath); } catch {}
  if (existing) {
    let same = false;
    try {
      const a = fs.realpathSync(linkPath).toLowerCase();
      const b = fs.realpathSync(targetDir).toLowerCase();
      same = a === b;
    } catch {}
    if (same) { log(`链接已存在且指向本仓库：${linkPath}`); return linkPath; }
    if (!existing.isSymbolicLink()) fatal(`${linkPath} 已存在且不是链接，请先手工移走或删除`);
    log(`链接指向别处，重建：${linkPath}`);
    fs.rmSync(linkPath, { recursive: true, force: true });
  }
  fs.symlinkSync(targetDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  log(`已创建链接：${linkPath} → ${targetDir}`);
  return linkPath;
}

/** 链接是否存在：必须用 lstat。对着一张**目标已被删除**的坏链接，existsSync 会返回 false。 */
function isLink(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

/** 删链接（坏链接也删得掉）。 */
function removeLink(p) {
  if (!isLink(p)) return false;
  try { fs.rmSync(p, { recursive: true, force: true }); return true; } catch { return false; }
}

// 写 profile package.json（改前备份一次）。
const pkgFile = path.join(PROFILE_DIR, 'package.json');
let pkg = { name: `dsh-profile-${PROFILE}`, private: true, dependencies: {}, dsh: { profile: { bundles: [] } } };
if (fs.existsSync(pkgFile)) {
  const backup = `${pkgFile}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(pkgFile, backup);
  log(`备份：${backup}`);
  try { pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8')); } catch (e) { fatal(`解析失败：${e.message}`); }
}
pkg.dependencies ??= {};
pkg.dsh ??= {};
pkg.dsh.profile ??= {};
pkg.dsh.profile.bundles ??= [];
const linkValue = `link:${PLUGIN_DIR.replace(/\\/g, '/')}`;
let changed = false;
if (pkg.dependencies[NAME] !== linkValue) { pkg.dependencies[NAME] = linkValue; changed = true; log(`dependencies.${NAME} = ${linkValue}`); }

// ① 清理改名前的旧登记与旧链接。**必须在建新链接之前**：
// 新链接落在 ~/.dsh/plugins/<扁平名>，而非作用域旧名的路径与它**完全相同**，
// 清理放到后面跑就会把自己刚建好的链接删掉，留下一张指向空目录的坏 junction（真踩过）。
for (const legacy of LEGACY_NAMES) {
  if (legacy === NAME) continue;
  if (pkg.dependencies[legacy] !== undefined) { delete pkg.dependencies[legacy]; changed = true; log(`已移除旧登记 dependencies.${legacy}`); }
  const at = pkg.dsh.profile.bundles.indexOf(legacy);
  if (at >= 0) { pkg.dsh.profile.bundles.splice(at, 1); changed = true; log(`已移除旧登记 bundles: ${legacy}`); }
  // 扁平名与旧名相同 → 这个路径马上要复用，别删。
  if (legacy !== FLAT_NAME && removeLink(path.join(DSH_HOME, 'plugins', legacy))) {
    log(`已移除旧链接：${path.join(DSH_HOME, 'plugins', legacy)}`);
  }
  // profile 侧：旧的非作用域包在 node_modules/<legacy>，与新的 node_modules/@scope/<name> 不同路径，永远可删。
  if (removeLink(path.join(PROFILE_DIR, 'node_modules', legacy))) {
    log(`已移除旧链接：${path.join(PROFILE_DIR, 'node_modules', legacy)}`);
  }
}

if (!pkg.dsh.profile.bundles.includes(NAME)) { pkg.dsh.profile.bundles.push(NAME); changed = true; log(`dsh.profile.bundles += ${NAME}`); }
if (changed) {
  fs.writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  log(`已写入：${pkgFile}`);
} else {
  log('package.json 无需改动（已登记）');
}

// ② 再建链接。作用域包落到 node_modules/@scope/<name>，父目录由 ensureLink 递归创建。
const installedAt = ensureLink(path.join(DSH_HOME, 'plugins', FLAT_NAME), PLUGIN_DIR);
ensureLink(path.join(PROFILE_DIR, 'node_modules', ...NAME.split('/')), installedAt);

// 链路的最终自检：junction 必须真的能解析回本仓库。
for (const p of [installedAt, path.join(PROFILE_DIR, 'node_modules', ...NAME.split('/'))]) {
  try {
    const real = fs.realpathSync(p);
    if (!fs.existsSync(path.join(real, 'package.json'))) fatal(`链接解析不到包根：${p} → ${real}`);
    log(`链路 OK：${p} → ${real}`);
  } catch (error) {
    fatal(`链接不可用：${p}（${error.message}）`);
  }
}

// 自检：包的 dsh.bundle.patch 指向的 patch 必须存在，entry id 必须等于设置命名空间名，
// 且 patch 里该 entry 的 name 必须与包名一致（不一致时加载器解析不到模块）。
const patchRel = manifest?.dsh?.bundle?.patch;
if (!patchRel) fatal('package.json 缺少 dsh.bundle.patch');
const patchFile = path.join(PLUGIN_DIR, patchRel);
if (!fs.existsSync(patchFile)) fatal(`patch 文件不存在：${patchFile}`);
const patchText = fs.readFileSync(patchFile, 'utf8');
if (!/id:\s*media-gen/.test(patchText)) fatal('cordis.patch.yml 里必须有一条 id: media-gen 的 entry（要与设置命名空间同名）');
if (!patchText.includes(NAME)) fatal(`cordis.patch.yml 里的 name 必须是 ${NAME}（与 package.json 的 name 一致）`);
log(`自带 patch 就绪：${patchRel}（id: media-gen，name: ${NAME}）`);

// 已安装到 profile 的那份 patch（用户目录，非本仓库）也同步 name，避免"仓库改了、profile 没改"。
const livePatch = path.join(PROFILE_DIR, 'cordis.patch.yml');
if (fs.existsSync(livePatch)) {
  const text = fs.readFileSync(livePatch, 'utf8');
  if (!text.includes(NAME) && /name:\s*['"]?dsh-media-gen['"]?/.test(text)) {
    fs.copyFileSync(livePatch, `${livePatch}.bak-name-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    const updated = text.replace(/name:\s*['"]?dsh-media-gen['"]?/g, `name: '${NAME}'`);
    fs.writeFileSync(livePatch, updated, 'utf8');
    log(`已同步 profile patch 的 entry name → ${NAME}（原文件已备份）`);
  } else {
    log('profile patch 的 name 已是正确值（或该 patch 未登记本插件）');
  }
}

const bundles = JSON.parse(fs.readFileSync(pkgFile, 'utf8')).dsh.profile.bundles;
log(`当前 bundles（${bundles.length}）：${bundles.join(', ')}`);
console.log('\n下一步：');
console.log('  1) 重启 DSH Desktop（或改一下 profile patch 触发宿主 HMR 热重载）——插件在启动时才装配。');
console.log('  2) 设置 → 生图 / 生视频：填 API Key（或设环境变量 DSH_MEDIA_API_KEY）。');
console.log('  3) 对话框输 /img、/vid 选模型，或直接让助手调用 media_gen_image / media_gen_video。');
console.log('  说明：要让长视频跑完，请给 profile patch 里这条 entry 设够 toolCallTimeoutMs（默认 60s 会掐断）。');