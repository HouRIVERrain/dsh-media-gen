// dsh-media-gen 的浏览器端（客户端半）。
//
// 形态照抄本机已装且可用的第三方客户端插件 dsh-ppt：
//   window.__ModuleLoader__.load({ id, factory: require => { const React = require('react'); … return { inject, apply } } })
// —— 纯 JS 直发，**不需要构建步骤**；React 由宿主的静态模块表提供。
//
// 提供两件事：
//   ① 设置里单开一页（settings.section 插槽）：填/清 API Key、选默认模型、测连接、刷模型目录
//   ② 对话框里选模型：/img 与 /vid 两个 popupSelect 命令，选中即写回宿主（下次生成用该模型），
//      然后你正常输入提示词发送即可（助手会带着这个模型调用生成工具）
//
// 数据都经插件自己的宿主接口 /dsh-media-gen/*（同源 fetch，带 Cookie）。
//
// ⚠️⚠️ 下面这个 id **必须与 package.json 的 name 完全一致**（也就是客户端模块图里的条目名）。
// 踩过的血案（2026-10-21，实测把整个 DSH 打成"无插件"状态）：
//   改包名为 @houriverrain/dsh-media-gen 后，这里仍写着旧的 'dsh-media-gen'。
//   client-modules 用**图条目名**调 invalidate()，名字对不上 → 失效不生效 →
//   同一个 bundle 被执行两次 → 同一 factory id 重复注册：
//     Uncaught Error: client-modules: duplicate factory registration for "dsh-media-gen"
//   这个未捕获异常直接让 Web 启动失败（web boot: 1 entry did not activate），
//   DSH 随即把 profile 重置成安全默认（只留 base + web-app）——用户的 13 个插件全部消失。
// 换包名时用 scripts/set-npm-scope.mjs 一起改，别手改。
const BUNDLE_ID = '@houriverrain/dsh-media-gen';

// 再套一层 try/catch：客户端 bundle 注册失败**绝不能打死整个 Web 启动**。
// 最坏只该是"这个插件的设置页缺失"，其它插件必须照常。
try {
window.__ModuleLoader__.load({
  id: BUNDLE_ID,
  factory: (require) => {
    const React = require('react');
    const { useState, useEffect, useCallback } = React;
    const h = React.createElement;
    const API = '/dsh-media-gen/';

    /**
     * 除 status 外都是会改状态的 POST。**必须带 JSON body 与 content-type**：
     * 宿主侧为挡跨站表单，只接受 `POST + application/json`，无 body 的 POST 会被判 415。
     * （实测踩过：不传 body 时 fetch 既没 content-type 又退化成 GET，"测试连接"直接失败。）
     */
    async function api(path, body) {
      const isPost = path !== 'status';
      const res = await fetch(API + path, isPost ? {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {})
      } : undefined);
      let data = null;
      try { data = await res.json(); } catch {}
      if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
      return data;
    }

    function useStatus() {
      const [status, setStatus] = useState(null);
      const [error, setError] = useState('');
      const [busy, setBusy] = useState(false);
      const reload = useCallback(async () => {
        try { setStatus(await api('status')); setError(''); }
        catch (e) { setError(String((e && e.message) || e)); }
      }, []);
      useEffect(() => { reload(); }, [reload]);
      return { status, error, busy, setBusy, setStatus, reload, setError };
    }

    /**
     * 把接口错误翻译成可操作的诊断。
     * 实测踩过：宿主半如果没有经 ctx.inject(['webServer']) 拿到路由服务，路由会静默不注册，
     * 页面上每个按钮都报 HTTP 404 —— 这时候唯一有用的提示是「重启 DSH」。
     */
    function diagnose(message) {
      const text = String(message || '');
      if (/HTTP 404/.test(text)) {
        return '宿主接口 /dsh-media-gen/ 不存在：插件宿主半没有注册路由（通常是刚更新了代码而 DSH 还没重启）。请重启 DSH Desktop 后再试。';
      }
      if (/Failed to fetch|NetworkError|Load failed/i.test(text)) {
        return '连不上宿主接口（网络层失败）：确认 DSH 正在运行，或重启 DSH Desktop。';
      }
      return text;
    }

    function MediaSection() {
      const { status, error, busy, setBusy, setStatus, reload, setError } = useStatus();
      const [keyInput, setKeyInput] = useState('');
      const [notice, setNotice] = useState('');
      const [imageModel, setImageModel] = useState('');
      const [videoModel, setVideoModel] = useState('');

      useEffect(() => {
        if (!status) return;
        setImageModel(String((status.store && status.store.imageModel) || (status.config && status.config.imageModel) || ''));
        setVideoModel(String((status.store && status.store.videoModel) || (status.config && status.config.videoModel) || ''));
      }, [status]);

      const run = (label, fn) => async () => {
        setBusy(true); setNotice(''); setError('');
        try { setNotice(await fn()); }
        catch (e) { setError(`${label}失败：${diagnose(e && e.message)}`); }
        finally { setBusy(false); }
      };

      const saveKey = run('保存 Key', async () => {
        await api('key', { apiKey: keyInput });
        setKeyInput('');
        // 存完立刻用新 key 探一次目录，省得用户还要手动点「刷新模型目录」。
        let extra = '';
        try {
          const data = await api('models', { force: true });
          extra = `，已探测：生图 ${data.images.length} 个、生视频 ${data.videos.length} 个`;
        } catch (error) {
          extra = `，但模型探测失败：${String((error && error.message) || error)}`;
        }
        setStatus(await api('status'));
        return `Key 已保存（仅存于本机插件存储，界面不回显）${extra}`;
      });

      const clearKey = run('清除 Key', async () => {
        await api('key', { apiKey: '' });
        setStatus(await api('status'));
        return 'Key 已清除（改回读环境变量 / 凭据存储 / profile 配置）';
      });

      const saveDefaults = run('保存默认模型', async () => {
        await api('defaults', { imageModel, videoModel });
        setStatus(await api('status'));
        return '默认模型已保存';
      });

      const refresh = run('刷新模型', async () => {
        const data = await api('models', { force: true });
        setStatus(await api('status'));
        return `已探测：生图 ${data.images.length} 个、生视频 ${data.videos.length} 个`;
      });

      const test = run('测试连接', async () => {
        const data = await api('test');
        const lines = (data.probes || []).map((p) => `${p.label}：HTTP ${p.status}${p.ok ? ' ✅' : ' ❌'}`).join('；');
        return lines || '测试完成';
      });

      const images = (status && status.catalog && status.catalog.images) || [];
      const videos = (status && status.catalog && status.catalog.videos) || [];
      const verified = new Set((status && status.config && status.config.verifiedImageModels) || []);
      const keySourceText = status ? (status.ready ? `已就绪（来源：${status.keySource}）` : '未配置') : '读取中…';

      return h('div', { className: 'card' },
        h('h3', null, '生图 / 生视频'),
        h('p', { className: 'muted' }, '填一次 API Key，插件自动探测可用模型；在对话里用 /img 或 /vid 选模型，然后直接输入提示词发送即可生成。'),

        h('p', null, h('strong', null, 'Key 状态：'), keySourceText,
          status && status.keyHint ? `　当前：${status.keyHint}` : ''),

        h('div', { className: 'tools' },
          h('input', {
            type: 'password',
            autoComplete: 'new-password',
            placeholder: '粘贴 API Key（写入本机 0600 文件，不回显）',
            value: keyInput,
            onChange: (e) => setKeyInput(e.target.value),
            style: { minWidth: '18rem' }
          }),
          h('button', { className: 'primary', disabled: busy || !keyInput.trim(), onClick: saveKey }, '保存 Key'),
          h('button', { disabled: busy, onClick: clearKey }, '清除 Key')
        ),

        h('div', { className: 'tools' },
          h('label', null, '默认生图模型：',
            h('select', { value: imageModel, onChange: (e) => setImageModel(e.target.value) },
              h('option', { value: '' }, '（自动：优先实测可用的）'),
              images.map((id) => h('option', { key: id, value: id }, verified.has(id) ? `${id} ← 实测可用` : id))
            )
          ),
          h('label', null, '默认生视频模型：',
            h('select', { value: videoModel, onChange: (e) => setVideoModel(e.target.value) },
              h('option', { value: '' }, '（自动）'),
              videos.map((id) => h('option', { key: id, value: id }, id))
            )
          ),
          h('button', { disabled: busy, onClick: saveDefaults }, '保存默认')
        ),

        h('div', { className: 'tools' },
          h('button', { disabled: busy, onClick: refresh }, '刷新模型目录'),
          h('button', { disabled: busy, onClick: test }, '测试连接')
        ),

        h('p', { className: 'muted' },
          `目录：生图 ${images.length} 个、生视频 ${videos.length} 个`,
          status && status.catalog && status.catalog.at ? `（更新于 ${new Date(status.catalog.at).toLocaleString()}）` : '',
          status && status.catalog && status.catalog.error ? `　探测告警：${status.catalog.error}` : ''
        ),
        notice ? h('p', null, notice) : null,
        // 对话命令的注册诊断：失败时直接显示原因，不再"输入 /img 毫无反应"。
        status && status.clientDiag ? h('p', { className: 'muted' },
          '对话命令：' + ((status.clientDiag.attempts || []).length
            ? status.clientDiag.attempts.map((a) => `${a.name} ${a.ok ? '✅ 已注册' : `❌ ${a.error || a.stage}`}`).join('；')
            : '（未尝试）')
          + (status.clientDiag.injectFired === false ? '｜注入回调未触发' : '')
          + (status.clientDiag.error ? `｜${status.clientDiag.error}` : '')
        ) : null,
        error ? h('p', { className: 'muted' }, diagnose(error)) : null,
        h('details', null, h('summary', null, '接口与协议'),
          h('p', { className: 'muted' },
            `生图端点：${status ? status.config.imageBaseUrl : '…'}（OpenAI 兼容 /images/generations）；`,
            `生视频端点：${status ? status.config.videoBaseUrl : '…'}（native DashScope 异步）。`,
            ' 视频是长任务：轮询间隔与超时见下，profile 里那条 entry 的 toolCallTimeoutMs 要大于它。'
          ),
          h('p', { className: 'muted' },
            status ? `videoTimeoutMs=${status.toolTimeouts.videoTimeoutMs}，pollIntervalMs=${status.toolTimeouts.pollIntervalMs}` : ''
          )
        )
      );
    }

    // ── 对话命令（/img、/vid）─────────────────────────────────────────────────
    // 教训：命令注册失败时**不能沉默**。首次实现把错误吞进 try/catch，结果"输入 /img 没反应"
    // 却查不出原因。现在每次尝试的结果都记下来并回报宿主（POST /dsh-media-gen/diag），
    // 于是不开浏览器也能从 GET /status 读到确切原因。
    let ICON;
    try { ICON = require('@deepseek-ai/dsh-client-ui-primitives').IconDataOutlineRegular; } catch { ICON = undefined; }

    const pickerDiag = { at: null, hasInject: null, hasCommandUi: null, injectFired: false, attempts: [], error: null };

    function reportDiag() {
      pickerDiag.at = new Date().toISOString();
      return api('diag', pickerDiag).catch(() => null);
    }

    /** 官方 /model 的 spec 形状：label/description 是 thunk，另有 icon 与 available。 */
    function pickerSpec({ name, kind, title }) {
      return {
        name,
        label: () => title,
        description: () => `${title}：选中后直接在对话框输入提示词发送`,
        ...(ICON ? { icon: ICON } : {}),
        available: () => true,
        ui: {
          kind: 'popupSelect',
          searchMode: 'fuzzy-label',
          searchLabels: () => ({
            placeholder: `搜索${title}模型`,
            empty: '没有可用模型：先在 设置 → 生图 / 生视频 里填 Key',
            noResults: '没有匹配的模型'
          }),
          options: async () => {
            const status = await api('status');
            const list = kind === 'image' ? (status.catalog.images || []) : (status.catalog.videos || []);
            const verified = new Set((status.config && status.config.verifiedImageModels) || []);
            const current = kind === 'image' ? (status.store && status.store.selectedImageModel) : (status.store && status.store.selectedVideoModel);
            return list.map((id) => ({
              id,
              label: id + (current === id ? '（当前）' : ''),
              detail: kind === 'image' && verified.has(id) ? '实测可用' : undefined,
              group: { name: kind, label: kind === 'image' ? '生图模型' : '生视频模型' }
            }));
          },
          onSelect: async (option) => {
            await api('select', { kind, model: option.id });
          }
        }
      };
    }

    function registerPicker(scope, spec) {
      const attempt = { name: spec.name, ok: false, stage: 'start', error: null };
      pickerDiag.attempts.push(attempt);
      try {
        const command = typeof scope.get === 'function' ? scope.get('commandUi') : scope.commandUi;
        attempt.hasService = Boolean(command);
        if (!command || typeof command.register !== 'function') {
          attempt.stage = 'no-service';
          attempt.error = 'commandUi 服务不可用';
          return null;
        }
        const dispose = typeof scope.effect === 'function'
          ? scope.effect(() => command.register(spec), `dsh-media-gen: /${spec.name}`)
          : command.register(spec);
        attempt.ok = true;
        attempt.stage = 'registered';
        attempt.hasIcon = Boolean(ICON);
        return dispose;
      } catch (error) {
        attempt.stage = 'threw';
        attempt.error = String((error && error.message) || error);
        return null;
      }
    }

    const PICKERS = [
      { name: 'img', kind: 'image', title: '生图' },
      { name: 'vid', kind: 'video', title: '生视频' }
    ];

    function apply(ctx) {
      // 设置页注册也套一层：重复 id 之类的问题只该让设置页缺失，不该让插件整体挂掉。
      try {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'dsh-media-gen',
          order: 57,
          label: () => '生图 / 生视频',
          inject: () => ({})
        }, MediaSection));
      } catch (error) {
        console.error('[dsh-media-gen] 设置页注册失败：', error);
      }

      pickerDiag.hasInject = typeof ctx.inject === 'function';
      pickerDiag.hasCommandUi = Boolean(ctx && ctx.commandUi);
      try {
        if (typeof ctx.inject === 'function') {
          ctx.inject(['commandUi'], (scope) => {
            pickerDiag.injectFired = true;
            for (const spec of PICKERS) registerPicker(scope, pickerSpec(spec));
            reportDiag();
          });
        }
      } catch (error) {
        pickerDiag.error = String((error && error.message) || error);
      }

      // 兜底：若 2.5 秒内注入回调始终没触发，而 ctx 上直接就有该服务，就同步试一次。
      setTimeout(() => {
        try {
          if (!pickerDiag.injectFired && ctx && ctx.commandUi && typeof ctx.commandUi.register === 'function') {
            for (const spec of PICKERS) registerPicker(ctx, pickerSpec(spec));
          }
        } catch (error) {
          pickerDiag.error = String((error && error.message) || error);
        }
        reportDiag();
      }, 2500);
    }

    // ⚠️ 插件级 `inject` 是**激活前置条件**，不是"我可能需要什么"的声明。
//    实测（2026-10-21）：把它写成 ['slots','commandUi'] 后，这个客户端插件**永远不激活** ——
//    `commandUi` 在本插件的挂载时机拿不到，于是整块客户端半（含设置页）一起消失。
//    对照：官方可用的第三方插件 dsh-ppt 只写 ['slots','locale']。
//    所以这里只声明真正保证存在的 slots，命令服务改用 `ctx.inject(['commandUi'], cb)` 惰性获取：
//    服务就绪就注册命令，没就绪也只是少两个命令，不会拖垮设置页。
return { inject: ['slots'], apply, __internals: { api, pickerDiag } };
  }
});
} catch (error) {
  console.error('[dsh-media-gen] 客户端 bundle 注册失败：设置页与 /img、/vid 会缺失，但宿主半（四个工具）与其它插件不受影响。原因：', error);
}