# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | ✅ |

## How this plugin handles your API key

The plugin needs an API key to call the upstream image/video endpoints. It never sends that key
anywhere except those endpoints, and it never writes it into this repository.

Key resolution order (first hit wins):

1. environment variable named by the `apiKeyEnv` config field (default `DSH_MEDIA_API_KEY`);
2. the DSH credential store, via `ctx.credentials` and `credentialRef(apiKeyEnv)`;
3. **the plugin's own store** — `~/.dsh/storages/media-gen/settings.json` (written by the settings
   page, created `0600`);
4. the `apiKey` field in the plugin config (profile patch) — the least preferred path, because that
   file is plain YAML.

### What the web surface exposes

The browser half talks to a single host route, `/dsh-media-gen/*`. Responses **never** contain the
key: `GET /dsh-media-gen/status` returns only `ready`, the *source* of the key, and a masked hint
(`sk-ws-…（共 116 字符）`). If you find any response that echoes a full key, that is a security bug —
please report it.

Write endpoints accept `POST` with `Content-Type: application/json` only, and reject
`Sec-Fetch-Site: cross-site` requests. This blocks web-page CSRF and accidental triggering.

**Honest threat model:** this does *not* protect against other processes or users on the same
machine. They can already read `~/.dsh/storages/media-gen/settings.json` and the DSH profile
directory. On Windows the file's POSIX mode is not enforced (`chmod` only toggles the read-only
bit), so treat that file as protected by your user account, not by file permissions.

### Logs and error messages

Key material is never logged. Errors surface the upstream HTTP status and body snippet, which can
contain your prompt — do not put secrets inside prompts.

## Reporting a vulnerability

Open a private security advisory on GitHub (Security → Advisories → New draft advisory) or, if that
is not possible, open an issue that says only "security issue, please contact me" without details.

Please include: affected version, a minimal reproduction, and what an attacker gains.
Expect an initial response within a few days.

## If your key leaks

Rotate it at your provider immediately, then:

- delete it from the plugin store (Settings → 生图 / 生视频 → 清除 Key, or delete
  `~/.dsh/storages/media-gen/settings.json`);
- change it in the DSH credential store if you stored it there;
- check the provider's usage/billing page for unexpected calls.