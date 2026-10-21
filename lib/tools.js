// 工具定义：把生图/生视频暴露成 DSH 工具。
//
// 为什么优先用 `createMcpToolDefinition`（@deepseek-ai/dsh-mcp-client 导出）：
//   官方文档原话是「一个规范值，一个投影」——它把 MCP 形状的
//   `{ content: [{type:'text'},{type:'image',data,mimeType}] }` 适配成 DSH 的规范值，
//   并在 tools/post-execute 之前安装真实图片块，于是**图片像普通图片一样出现在对话里**。
//   这也是官方给「自写工具」准备的通道（原生 Cua 提供方就走它）。
//   拿不到该模块时退化成纯文本工具（仍能用，只是不内联显示图片）。
import path from 'node:path';
import os from 'node:os';
import { summarize } from './media.js';

export const TOOL_NAMES = ['media_status', 'media_list_models', 'media_gen_image', 'media_gen_video'];

/** 从 ToolExecution 里尽力找出会话工作区；找不到就返回空串（调用方会退化到 ~/.dsh）。 */
export function workspaceOf(exec) {
  const candidates = [
    exec?.cwd, exec?.workspace, exec?.session?.cwd,
    exec?.agent?.cwd, exec?.agent?.session?.cwd, exec?.agent?.session?.workspace
  ];
  for (const c of candidates) if (typeof c === 'string' && c.trim()) return c.trim();
  return '';
}

/** 产物目录候选：显式 outputDir > 工作区 output/<kind> > ~/.dsh/storages/media-gen/output/<kind>。 */
export function outputDirs(cfg, exec, kind) {
  const fallback = path.join(os.homedir(), '.dsh', 'storages', 'media-gen', 'output', kind);
  const ws = workspaceOf(exec);
  const dirs = [];
  if (ws) dirs.push(path.join(ws, 'output', kind));
  dirs.push(fallback);
  return { dirs, requestedDir: cfg.outputDir || '', workspace: ws || undefined };
}

const JSON_TEXT = (value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];

/**
 * 构建工具定义。
 * @param ctx 插件上下文（用于 createMcpToolDefinition 的附件/模型服务）
 * @param api 由 index.js 注入的能力：{ run(name, args, exec) }，真正的执行在 index 里统一做
 */
export async function buildTools(ctx, api) {
  let createMcpToolDefinition = null;
  try {
    ({ createMcpToolDefinition } = await import('@deepseek-ai/dsh-mcp-client'));
  } catch {
    createMcpToolDefinition = null;
  }

  const specs = [
    {
      name: 'media_status',
      description: '只读：检查生图/生视频插件的就绪度——key 来源、两套端点、默认模型、缓存的模型目录、最近一次错误。不返回任何 key。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: (args, exec) => api.run('media_status', args, exec)
    },
    {
      name: 'media_list_models',
      description: '只读：自动探测可用的生图与生视频模型（生图走 OpenAI 兼容面 /models，生视频走 native DashScope 面 /models；结果按 TTL 缓存）。',
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['all', 'image', 'video'], description: '只列某一类，默认 all' },
          force: { type: 'boolean', description: '忽略缓存强制重新探测' }
        },
        additionalProperties: false
      },
      run: (args, exec) => api.run('media_list_models', args, exec)
    },
    {
      name: 'media_gen_image',
      description: '生成一张图片：调用配置的生图端点（OpenAI 兼容 /images/generations），保存为本地文件，并把图片本身作为结果返回（对话里直接显示）。',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '画面描述，中文即可' },
          model: { type: 'string', description: '覆盖默认生图模型（见 media_list_models）' },
          size: { type: 'string', description: '尺寸或比例，如 1024x1024 / 1:1 / 16:9' },
          filename: { type: 'string', description: '自定义文件名（不含扩展名）' }
        },
        required: ['prompt'],
        additionalProperties: false
      },
      run: (args, exec) => api.run('media_gen_image', args, exec)
    },
    {
      name: 'media_gen_video',
      description: '生成一段视频：走 native DashScope 异步协议（提交 → 轮询 → 下载），保存为本地 mp4 并返回文件路径。耗时通常 1~7 分钟。传 imageUrl 可图生视频。',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '画面描述，中文即可' },
          model: { type: 'string', description: '覆盖默认生视频模型，如 MiniMax/MiniMax-H3' },
          ratio: { type: 'string', description: '画面比例：16:9 / 9:16 / 1:1 / 4:3 / 3:4 / 21:9（H3 必须显式给）' },
          size: { type: 'string', description: '像素写法（wan 系用），如 1280*720' },
          seconds: { type: 'number', description: '时长（秒）；不传用平台默认（H3 实测 6.6 秒）' },
          imageUrl: { type: 'string', description: '图生视频的首帧图 https 地址' },
          filename: { type: 'string', description: '自定义文件名（不含扩展名）' }
        },
        required: ['prompt'],
        additionalProperties: false
      },
      run: (args, exec) => api.run('media_gen_video', args, exec)
    }
  ];

  return specs.map((spec) => {
    // 官方通道：MCP 形状结果 → 规范值 + 持久图片投影。
    if (typeof createMcpToolDefinition === 'function') {
      return createMcpToolDefinition(ctx, {
        name: spec.name,
        rawName: spec.name,
        description: spec.description,
        inputSchema: spec.inputSchema,
        call: async (args, execution) => spec.run(args ?? {}, execution)
      });
    }
    // 退化通道：纯文本工具（拿不到 mcp-client 时仍然可用）。
    return {
      name: spec.name,
      description: spec.description,
      parameters: spec.inputSchema,
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => JSON_TEXT(value) },
      execute: async (args, exec) => {
        const result = await spec.run(args ?? {}, exec);
        return (result?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      }
    };
  });
}

export { JSON_TEXT };
export { summarize };