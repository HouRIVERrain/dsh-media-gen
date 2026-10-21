# dsh-media-gen

Image **and** video generation for **DeepSeek Harness (DSH)**. Paste one API key, let the plugin
discover which models you can actually use, then just ask the assistant to *"draw an orange cat
wearing headphones"* or *"generate a 5-second video"* — or pick a model yourself from the chat box
with `/img` and `/vid`.

[![CI](https://github.com/HouRIVERrain/dsh-media-gen/actions/workflows/ci.yml/badge.svg)](https://github.com/HouRIVERrain/dsh-media-gen/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40houriverrain%2Fdsh-media-gen)](https://www.npmjs.com/package/@houriverrain/dsh-media-gen)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

Chinese docs: **[README.zh.md](./README.zh.md)** — the full field table, the evidence trail, measured
numbers and pricing notes live there.

## What you get

- **Images render inline in the conversation** — projected through DSH's official
  `createMcpToolDefinition` channel, so it is a real image block, not a link you have to click.
- **Videos are delivered as local mp4 files** (DSH has no inline-video contract), with the file path
  returned in the tool result.
- **Two API faces, one plugin.** Image models are discovered from an OpenAI-compatible
  `/models`; video models from the native DashScope `/api/v1/models` — 88 video models on the
  gateway this was built against, which the OpenAI-compatible face does not expose at all.
- **"Listed" ≠ "usable", and the plugin says so.** On the reference gateway only 3 of 12 listed
  image models actually worked. The plugin keeps a verified-good list, retries automatically when
  your requested model is missing/rejected, and reports the substitution honestly in the result
  (`requestedModel` / `substituted` / `attempts`).
- **Its own settings page** (Settings → 生图 / 生视频): key status, masked hint, default model
  pickers, model refresh, connectivity test. **No YAML editing required.**
- **Model pickers inside the chat box**: `/img` and `/vid` open a searchable, grouped model list;
  your choice is remembered and used by the next generation.

## Requirements

- DSH `>= 0.2.0-rc.1` (desktop or web composition) and Node `>= 22.13.0`.
- An API key for an image endpoint and (optionally) a video endpoint — see
  [Endpoints](#endpoints) for what the defaults point at.

## Install

```powershell
# scoped npm package
dsh plugin --profile desktop add @houriverrain/dsh-media-gen

# straight from GitHub (pin a commit for reproducibility)
dsh plugin --profile desktop add github:HouRIVERrain/dsh-media-gen#<sha>

# local development: link a checkout
dsh plugin --profile desktop add link:C:\path\to\dsh-media-gen
```

Then restart DSH (or touch the profile patch to let the host HMR reload it). If the `dsh` CLI is not
on your `PATH`, `node scripts/link-install.mjs desktop` performs the equivalent install by hand
(junction + profile `package.json` + patch self-check).

## Configure

**Settings → 生图 / 生视频** — a page the plugin registers itself:

| Control | What it does |
| --- | --- |
| Key status | shows *where* the key came from and a masked hint (`sk-ws-…（共 116 字符）`) — never the key |
| Save / Clear key | writes / removes the plugin's own store (`~/.dsh/storages/media-gen/settings.json`, `0600`) |
| Default image / video model | dropdowns built from the discovered catalog; verified-good image models are marked |
| Refresh catalog | re-discovers models (`force`) |
| Test connection | one read-only `GET /models` per endpoint; reports status codes only |

Key resolution order (first hit wins):

1. environment variable named by `apiKeyEnv` (default `DSH_MEDIA_API_KEY`);
2. DSH credential store via `ctx.credentials`;
3. **the plugin's own store** — what the settings page writes;
4. the `apiKey` field in the plugin config (profile patch) — least preferred, that file is plain YAML.

Everything else (endpoints, default models, size, ratio, poll interval, timeouts, output dir) is in
the plugin `Config` schema and can be set from the settings form or the profile patch. See the
[Chinese README](./README.zh.md#二安装与配置) for the full field table.

### Endpoints

Defaults target a Qianwen MaaS gateway (`https://maas.qianwenaiapi.com/...`): OpenAI-compatible for
images, native DashScope for video. Any gateway exposing those two shapes works — point
`imageBaseUrl` / `videoBaseUrl` somewhere else and the discovery adapts.

## Use

**From the chat box.** Type `/img` (image) or `/vid` (video), pick a model from the popup, then send
your prompt normally. The plugin remembers the pick (`~/.dsh/storages/media-gen/settings.json`) and
uses it for the next generation.

**Let the assistant call the tools.** Four tools are registered:

| Tool | Purpose |
| --- | --- |
| `media_status` | Read-only readiness: key source, endpoints, defaults, cached catalog, route/diagnostic state (never the key) |
| `media_list_models` | Discover image/video models (`kind`, `force`); verified-good image models are marked |
| `media_gen_image` | Generate → save → **inline image block in the conversation** |
| `media_gen_video` | Submit → poll → download mp4 → return the local file path |

Typical result of `media_gen_image`:

```json
{
  "file": "C:\\Users\\you\\.dsh\\storages\\media-gen\\output\\images\\a-cat-2026-10-21T10-31-16.png",
  "bytes": 824341, "model": "qwen-image-3.0-pro", "ms": 92922,
  "requestedModel": "qwen-image-3.0-pro", "substituted": null
}
```

> Long videos need a raised tool timeout: set `toolCallTimeoutMs` (e.g. `1800000`) on this plugin's
> entry in the profile patch, otherwise DSH's default 60 s cuts the call off while polling.

## Verified, not assumed

Measured on the reference gateway (2026-10-21) through the plugin's own code path:

| Item | Result |
| --- | --- |
| Offline assertions | 4 tools registered, parameter contracts, 17 config fields volatile, `apiKey` the only `secret`, host route registered |
| Model discovery | 12 image models (OpenAI-compatible face) + 88 video models (native face) |
| Image models that actually work | **3 of 12**: `qwen-image-3.0` (¥0.18), `qwen-image-2.1-pro` (¥0.25), `qwen-image-3.0-pro` (¥0.25/1K) |
| `media_gen_image` | 824 KB PNG in 93 s, return value contains an inline image block |
| `media_gen_video` | `MiniMax/MiniMax-H3` and `happyhorse-1.1-t2v`: 3.75 MB mp4, 112 s, `avc1` video + `mp4a` audio, 5.16 s long |
| Fallback chain | requesting a 404 model (`z-image-turbo`) auto-retried `qwen-image-3.0` and reported `substituted` |
| Host HTTP route | `/dsh-media-gen/*` reachable, key never echoed, 415/403/404/405 guards all fire |

## Design notes (and two traps worth knowing)

### Why generation does not live in the model dropdown

Enforced by first-party contracts, not by this plugin's choice:

1. `ModelModalityMap { text, image }` — `LlmModelInfo` has only `inputModalities`; there is **no
   output-modality field at all**.
2. `dsh-llm-pi-ai` source: `case "image": throw new LlmError("pi-ai chat history cannot represent
   structured assistant image output", "UNSUPPORTED_CONTENT")`.
3. `dsh-attachment` README: *"…the role-neutral `ImageBlock` leaves assistant-side image output as
   **forward compatibility** — current production adapters declare text-only output."*
4. `dsh-client-ui-model-selection` README: the `conversation.input.model.label` slot *"must render
   **non-interactive** inline content … The selector owns clicks, search, focus, disabled states."*

So generation ships as **tools + attachment/file projection** and, for picking a *generation* model,
the official `ctx.commandUi` popup (`/img`, `/vid`).

### Trap 1: prefix routes must not end with a slash

`dsh-host-webserver` matches prefixes with `pathname === prefix || pathname.startsWith(prefix + "/")`.
Registering `'/dsh-media-gen/'` therefore compares against `'/dsh-media-gen//'` and **never matches**
`/dsh-media-gen/status` — `register()` does not throw, the route looks "registered", and every
request 404s. Register `'/dsh-media-gen'`. There is a regression test for exactly this
(`test/host-api.test.mjs`).

### Trap 2: optional services must be injected

Touching `ctx.webServer` without declaring it yields `undefined` and silently skips registration.
Follow the official pattern: `ctx.inject(['webServer'], scope => …)` (see `dsh-api-gateway`,
`dsh-client-connection`). `media_status` reports the resulting state as `webRoute`.

## Host HTTP API (for the browser half)

One prefix route, `/dsh-media-gen/*`; responses never include the key.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/dsh-media-gen/status` | readiness, key source + masked hint, catalog, endpoints, client diagnostics |
| POST | `/dsh-media-gen/key` | set / clear the key (`{"apiKey": ""}` clears) |
| POST | `/dsh-media-gen/defaults` | save default image/video model |
| POST | `/dsh-media-gen/select` | the `/img` `/vid` pickers write the chosen model here |
| POST | `/dsh-media-gen/models` | refresh the catalog (`{"force": true}`) |
| POST | `/dsh-media-gen/test` | one read-only probe per endpoint |
| POST | `/dsh-media-gen/diag` | the browser half reports its own diagnostics (command registration etc.) |

Write endpoints accept `POST` + `application/json` only and reject `Sec-Fetch-Site: cross-site`.
Threat model — and what this does **not** protect against — is documented in
[SECURITY.md](./SECURITY.md).

## Development

```powershell
npm test                  # offline: tool registration, config contract, host API, no key leaks
npm run test:live         # really generates one image (costs money)
npm run test:live-video   # really generates one video (1–7 min, costs money)
npm run install:local     # install into a profile without the dsh CLI
npm run verify:patches    # static check of the profile patch before restarting DSH
```

There is no build step: the browser half is plain JavaScript loaded via
`window.__ModuleLoader__.load(...)`, exactly like shipped client plugins.

**Host HMR tip:** this plugin is installed as a linked package, so editing its files and then
touching the profile patch makes DSH reload it **without a restart** (documented behaviour of
`@deepseek-ai/dsh-hmr`). That is how the host-side fixes in this repo were verified live.

## Relation to other plugins

There are already DSH plugins in this space — notably the npm package
[`dsh-media-gen`](https://www.npmjs.com/package/dsh-media-gen) by another author (unscoped name,
different codebase) and `dsh-video-gen`. **This package is not affiliated with them**; it is
published under the `@houriverrain` scope to avoid the name collision. Tool names here are
`media_gen_image` / `media_gen_video`, and `/img` / `/vid` command names may collide if another
plugin registers the same names — DSH reports that explicitly rather than silently overriding, and
this plugin surfaces its own registration state in `media_status` and on the settings page.

## Limitations

- **Model catalogs are endpoint-specific.** "Listed" does not mean "callable"; the verified-good list
  in `lib/media.js` was measured against one gateway and needs re-measuring for yours.
- **Video parameter shape differs by model family.** MiniMax-H3 requires `parameters.ratio`
  (`t2va` rejects `adaptive`); the `wan` family takes `parameters.size` in pixels. The plugin routes
  by model name, but a brand-new family may need a new branch.
- **Image-to-video** is wired (`imageUrl`) but has not been exercised end-to-end on the reference
  gateway.
- **The browser half needs a refresh to update.** Client bundles hot-reload, but a page that was
  opened before a change may need `Ctrl+R`.
- **Single-image multi-panel sheets obey layout instructions only partially** — a property of the
  models, not of this plugin.

## Security

API keys are never echoed back, never written to logs, and stored outside this repository. See
[SECURITY.md](./SECURITY.md) for the resolution order, the web-surface threat model, and how to
report an issue.

## License

MIT — see [LICENSE](./LICENSE).