// 插件自有的设置存储（宿主侧）。
//
// 为什么不直接写 profile patch：patch 是明文 YAML、由 loader 管理，插件不该反复改它。
// 这里用 0600 权限的 JSON 存密钥与默认值，由插件自己的 HTTP 接口读写（设置页调用），
// 取值优先级：环境变量 → DSH 凭据存储 → **本文件** → profile patch 的 config。
//
// 内容永不回显：对外只给 { keySet, keySource, keyHint }，hint 只保留前 6 位与长度。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FILE = path.join(os.homedir(), '.dsh', 'storages', 'media-gen', 'settings.json');

const EMPTY = Object.freeze({
  apiKey: '',
  imageModel: '',
  videoModel: '',
  videoRatio: '',
  videoSeconds: 0,
  selectedImageModel: '',
  selectedVideoModel: '',
  updatedAt: null
});

export function storeFile() {
  return FILE;
}

export function readStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { ...EMPTY, ...(raw && typeof raw === 'object' ? raw : {}) };
  } catch {
    return { ...EMPTY };
  }
}

/** 合并写回；只接受白名单字段。返回写后的完整值。 */
export function writeStore(patch = {}) {
  const allowed = ['apiKey', 'imageModel', 'videoModel', 'videoRatio', 'videoSeconds', 'selectedImageModel', 'selectedVideoModel'];
  const next = { ...readStore() };
  for (const key of allowed) {
    if (Object.hasOwn(patch, key)) next[key] = patch[key];
  }
  next.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(FILE, 0o600); } catch {}
  return next;
}

export function clearStore() {
  try { fs.rmSync(FILE, { force: true }); } catch {}
  return { ...EMPTY };
}

/** 只用于界面提示的前缀：绝不返回完整密钥。 */
export function keyHint(apiKey) {
  const value = String(apiKey ?? '');
  if (!value) return null;
  return `${value.slice(0, 6)}…（共 ${value.length} 字符）`;
}

/** 面向前端的只读视图：不含密钥。 */
export function storeView() {
  const store = readStore();
  return {
    keySet: Boolean(store.apiKey),
    keyHint: keyHint(store.apiKey),
    imageModel: store.imageModel || null,
    videoModel: store.videoModel || null,
    videoRatio: store.videoRatio || null,
    videoSeconds: store.videoSeconds || null,
    selectedImageModel: store.selectedImageModel || null,
    selectedVideoModel: store.selectedVideoModel || null,
    updatedAt: store.updatedAt
  };
}