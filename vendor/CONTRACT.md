# Registry contract

Pin: **pnpm `v12.1.0`** (`next-12` on 2026-08-30; npm `latest` was still 11.24.0).
Sources: `pnpm/crates/publish`, `pnpm/crates/network-web-auth`, `pnpm/crates/auth-commands`.
Local OpenAPI: [`npm-registry.yaml`](./npm-registry.yaml). That YAML is **not** npm’s public spec ([api-docs.npmjs.com](https://api-docs.npmjs.com/)). Do not fetch npm OpenAPI as the source of truth. Re-read this file before changing login, PUT, OTP, or OIDC.

pnpm 12 is a Rust rewrite (`pnpm-publish`, `pnpm-network-web-auth`). It does **not** depend on `libnpmpublish`. pnpm 11 still does.

## What we speak (same as pnpm 12)

| Call | pnpm 12 | Ours |
| --- | --- | --- |
| Web login | `POST /-/v1/login`, headers `npm-auth-type: web`, `Accept`/`Content-Type` JSON | Same path + `npm-auth-type: web`. See divergences. |
| Poll | `GET` the **opaque** `doneUrl`. Fetch errors and `!ok` (including 404) retry; 202 sleeps additional `Retry-After` minus the 1s interval, then retries; 200 `{ token }` succeeds; empty 200 retries. Default budget 5 min. Sleep 1s before the first GET. | Same GET. Sleep `loginRetry.minTimeout` then Ky `afterResponse` + `ky.retry({ delay })` for 404 / empty 200 / 202. 202 delay is `max(interval, Retry-After ms)` (JS `Number`; NaN → interval). Budget is `AbortSignal.timeout` (`loginRetry` 20 min). Origin rewrite below. |
| Publish | `PUT /{escapedName}` (`/` → `%2f`, `@` unencoded). Body from `build_publish_document`. Headers `npm-auth-type: web`, `npm-command: publish`, optional `npm-otp`. HTTP/1.1, User-Agent, 60s `fetchTimeout`. | Same path via `escapedPackagePath`. No `?access=`. User-Agent `bun-release/<version>`. GET/login/OIDC/trust: 60s. PUT `timeout: false` (binary tarball JSON exceeds a typical 60s upload). `fetch(..., { protocol: 'http1.1' })`. |
| OTP | 401 + `WWW-Authenticate` token `otp` **or** body contains `one-time pass`. JSON may have `authUrl`/`doneUrl`; poll then retry PUT with `npm-otp`. Classic OTP (no nested URLs) prompts TTY. | Same detection. Nested `authUrl`/`doneUrl` **or** `loginUrl`/`doneUrl`. Trust OTP 401 with neither pair retries the **same** GET/POST **without** `npm-otp` to elicit challenge URLs, then polls those. Do **not** use a web-login session token as `npm-otp` (npm 400 `OTP verification failed`). PUT with neither pair fails closed (no TTY). |
| Trust | npm public API: `GET`/`POST /-/package/{package}/trust` require `npm-otp` (2FA polling payload when omitted). pnpm 12 does not register trust. | Same path via `escapedPackagePath`. `npm-auth-type: web`. Same OTP recovery as PUT. Non-OTP 429 retries honor `Retry-After` or capped backoff; OTP-bearing 429 never replays the one-time credential. |
| OIDC exchange | `POST /-/npm/v1/oidc/token/exchange/package/{escaped}` Bearer **id-token**. Body `{ token }`. | Same. |
| GitHub id-token | `GET ACTIONS_ID_TOKEN_REQUEST_URL?audience=npm:<registry-host>` Bearer `ACTIONS_ID_TOKEN_REQUEST_TOKEN`; JSON `{ value }`. | Same. Not in the npm YAML. Not Octokit. |

Do **not** use Octokit for the id-token GET. That URL is the Actions **runner** OIDC endpoint (env-injected), not `api.github.com`. Octokit is REST/GraphQL. The official JS helper is `@actions/core` `getIDToken(audience)`, which is the same GET plus their HTTP client and `setSecret`. pnpm 12, npm, and we all call the env URL directly. Do not add `@actions/core` for one GET.

### Publish document (`build_publish_document`)

Root: `_id` = name only, `name`, optional `description`, `dist-tags`, `versions`, `access`, `_attachments`.
Each version: full `package.json` plus `_id` = `name@version`, `version`, `dist` `{ integrity, shasum, tarball }`.
Tarball URL: `{name}/-/{name}-{version}.tgz` joined to the registry, then **`https://` → `http://`**.
Attachment: `content_type: application/octet-stream`, base64 `data`, `length`.
`dist` lives **on the version**, not the packument root (npm’s public `publish.yaml` is wrong here).

## Divergences (intentional)

| Topic | pnpm 12 | bun-release | Keep |
| --- | --- | --- | --- |
| Login body | `{}` | `{ hostname }` + `npm-command: login` | **Ours.** Empty `{}` on npmjs is treated as a publish and 401s. |
| `doneUrl` host | GET as returned | Rewrite `registry.npmjs.org` → configured registry origin (npm-profile / npm/cli#8875) | **Ours.** pnpm 12 does not. |
| `access` | JSON field only (`null` if unset). PUT path has **no** query. | JSON `public`/`restricted`. No query. | **Ours** keeps JSON `access`; dropped the extra query. |
| Escape | `%2f` | `%2f` | Same. |
| Poll budget | 5 min default | 20 min | Operator browser login. |
| PUT timeout | 60s `fetchTimeout` | PUT `timeout: false`; other registry calls 60s | Binary packuments. |
| Packument GET | Not used to skip | Unauthenticated `GET /{escaped}` to skip existing versions and verify accepted PUTs | Bootstrap-only. Missing packages PUT serially; visibility polls run concurrently behind a final barrier. Not in npm OpenAPI. |

## Out of scope (pnpm has them; we do not)

- Classic login `PUT /-/user/org.couchdb.user:{name}` (404/405 fallback).
- Staged publish `POST /-/stage/package/{escaped}`.
- Sigstore provenance attachments.
- Couch / `.npmrc` / `auth.ini`.

## npm public OpenAPI vs this YAML

Present on api-docs: `PUT /{escapedPackageName}`, `GET`/`POST /-/package/{package}/trust`, OIDC exchange.
Absent there, present here because pnpm 12 / npm-profile speak them: `POST /-/v1/login`, `GET /-/v1/done` (poll the returned URL; query is whatever the server put on it, often `sessionId` / `authId`), packument `GET`.

Trust GET/POST is npm’s spec and our **bootstrap** (first-publish OIDC). pnpm 12 publish does not register trust.

## App vs spec

OpenAPI cannot “GET this URL from the previous JSON field.” After login/OTP, rewrite origin if needed, then GET the opaque `doneUrl` (path + query as returned). Do not reconstruct `/-/v1/done` from `sessionId`. GitHub’s request URL stays env-driven, not in `npm-registry.yaml`.
