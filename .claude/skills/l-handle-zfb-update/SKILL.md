---
name: l-handle-zfb-update
description: >-
  Update the zfb upstream dependency (the @takazudo/zfb* packages) in this
  example (kv-guestbook) to the latest stable release, review what changed
  upstream between versions, and adapt this project's code if a change touches a
  surface it uses. Use when: (1) User says 'update zfb', 'bump zfb', 'zfb
  update', or 'handle zfb update', (2) A new zfb release is out and this
  example should track it.
user-invocable: true
argument-hint: "[target-version, e.g. 3.1.0 — omit to use latest stable]"
---

# Handle zfb Update — kv-guestbook

This is a Cloudflare Workers KV guestbook: a server-rendered `prerender = false`
homepage with a no-JS HTML form, plus JSON API endpoints and an admin delete, all
backed by the same KV helpers. It uses a KV namespace binding (`GUESTBOOK`) and an
`ADMIN_TOKEN` secret.

Bump every `@takazudo/*` package this repo depends on to the latest stable
release (kept in lockstep on one version), review what changed upstream, and
adapt this project only where an upstream change touches a surface it actually
uses.

Upstream repo: `Takazudo/zudo-front-builder` (monorepo; npm packages live under
`packages/`). Every release has a `v<version>` tag and GitHub release notes.

## Step 0 — Preconditions

`package.json` and `pnpm-lock.yaml` must be clean (`git status --short` shows
neither). If either is dirty, stop and ask before touching them.

## Step 1 — Resolve current and target versions

```bash
CURRENT=$(node -p "require('./package.json').dependencies['@takazudo/zfb']")
TARGET=${1:-$(npm view @takazudo/zfb dist-tags.latest)}
```

- Always resolve the target from the `latest` dist-tag, never `next` — this repo
  tracks the zfb stable line. The `next` prerelease channel is dead: it ended at
  `1.1.0-next.1`, a prerelease of `1.1.0`, which shipped long ago and has since
  been superseded by 1.1.1, 2.0.0, 2.1.0, 2.2.0 and 2.3.0. Resolving from `next`
  therefore pins a stale prerelease of an already-released version.
- If `CURRENT` == `TARGET`: report "already at the latest stable (<version>)" and STOP.
- If an explicit target is older than `CURRENT`, that is a downgrade — stop and
  confirm first. **Never go below `3.0.0`**: this project uses the zfb 3 config
  (`wind`, no `framework` key) and the owned zudo-react JSX runtime, neither of
  which exists in 2.x.
- **If `TARGET` crosses a major version** (e.g. `3.x → 4.0.0`), treat it as a
  runtime migration, not a two-line package edit. Before Step 3, read that
  major's upstream migration guide
  (`docs/src/content/docs/guides/migrating-to-v<N>.mdx` at the release tag).
  Run Step 5's full major-bump verification, including the v(N-1) vs vN
  side-by-side comparison.

## Step 2 — Review upstream changes BEFORE bumping

Enumerate versions between CURRENT (exclusive) and TARGET (inclusive) in publish
order — never sort prerelease strings lexically (`next.9` vs `next.10`):

```bash
node -e '
const vs = JSON.parse(process.argv[1]);
const cur = vs.indexOf(process.argv[2]), tgt = vs.indexOf(process.argv[3]);
if (tgt < 0) { console.error("target not found"); process.exit(1); }
if (cur >= 0 && tgt <= cur) { console.error("not newer than current"); process.exit(1); }
console.log(vs.slice(cur + 1, tgt + 1).join("\n"));
' "$(npm view @takazudo/zfb versions --json)" "$CURRENT" "$TARGET"
```

Read the release notes for EVERY enumerated version:

```bash
gh release view "v<version>" --repo Takazudo/zudo-front-builder --json body -q '.body'
```

If a release has no notes, fall back to the commit list:

```bash
gh api "repos/Takazudo/zudo-front-builder/compare/v<prev>...v<version>" \
  --jq '.commits[].commit.message' | head -40
```

**Fail closed:** if the changes cannot be reviewed at all, stop and ask — never
bump blind.

Flag anything that touches a surface this example uses:

| Upstream surface | Where this project uses it |
| --- | --- |
| `defineConfig` schema (`zfb/config` shorthand, typed by `zfb-shim.d.ts`) | `zfb.config.ts` — adapter + `wind: { spec: 1, reset: "owned-v1" }` |
| zudo-react JSX runtime (`jsxImportSource: "@takazudo/zfb/zudo-react"`, `Child`, HTML attribute spellings) | `tsconfig.json`, `layouts/default.tsx`, `pages/*.tsx` |
| zudo-react raw-text elements (`<style rawHtml={…} />`; a text child throws `ZR_RAW_HTML`, zudo-front-builder#3390) | `layouts/default.tsx` (`CRITICAL_CSS`) |
| Page functions returning a `Response` (303 redirects, 503/405) | `pages/index.tsx`, `pages/api/*` |
| Cloudflare adapter + `getCloudflareContext()` (KV `GUESTBOOK`) | `lib/kv.ts`, `pages/index.tsx`, `pages/api/entries.tsx`, `pages/api/entries/[key].tsx` |
| API route contract (`export const prerender = false`) | `pages/index.tsx` (POST form), `pages/api/entries.tsx`, `pages/api/entries/[key].tsx` |
| Dynamic route contract (`[key]` param) | `pages/api/entries/[key].tsx` |
| Layouts | `layouts/default.tsx` |
| zudo-wind reset + CSS entry pipeline (owned-v1; parity rules for the 2.x preflight, zudo-front-builder#3382) | `styles/global.css` — linked only by the prerendered `404.html`; the SSR home links no stylesheet |
| CLI (`zfb dev/build/preview/check`) | `package.json` scripts, `wrangler.toml` |

Rule: adapt only if this project actually uses the changed feature. Internal zfb
changes (Rust internals, docs, other frameworks) need no action — note and move on.

## Step 3 — Bump every @takazudo/* package (lockstep)

```bash
PKGS=$(TARGET="$TARGET" node -p "Object.keys(require('./package.json').dependencies).filter(n=>n.startsWith('@takazudo/')).map(n=>n+'@'+process.env.TARGET).join(' ')")
pnpm add -E $PKGS
```

- `-E` keeps the exact pin (no caret) — this repo tracks one known-good zfb version.
- All `@takazudo/*` packages must land on the SAME version.
- Commit `package.json` AND `pnpm-lock.yaml` together — CI installs with
  `pnpm install --frozen-lockfile` and fails on a stale lockfile.
- pnpm is the package manager; npm is only for reading registry metadata.

## Step 4 — Adapt project code (only if Step 2 flagged something)

Apply what the flagged notes require (config schema, renamed APIs, adapter or
`ctx` changes, island markup, etc.). Update `README.md` if commands or documented
behavior changed. If nothing was flagged, skip.

## Step 5 — Verify

```bash
rm -rf ./dist ./.zfb ./.zfb-build
pnpm typecheck   # zfb check passes; run it BEFORE build — tsc names the file and the HTML spelling
pnpm build       # pages build cleanly, adapter writes dist/_worker.js + dist/.assetsignore
```

Cloudflare bindings are unavailable under `zfb build` / `zfb dev`; binding-backed
routes return a controlled `503`, which is expected. Exercise real KV with
`pnpm build` then `pnpm exec wrangler dev` (local KV state lives under
`.wrangler/`), per the README.

Always pass an explicit free port, and give smoke the explicit local URL; the
default smoke target is the live domain.

```bash
P=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')
pnpm preview --port $P --host 127.0.0.1 &
pnpm smoke http://127.0.0.1:$P
pkill -f -- "--port $P"   # zfb preview spawns `wrangler dev` children; killing only the zfb pid leaves them running
```

Two `wrangler dev` instances started at the same moment can race for the same
workerd inspector port (`Address already in use … :9235`). Start them one at a
time.

### Major-version bumps: prove parity, not just a green build

A green build does not show the page still looks and behaves the same. For a
major bump, also run the following.

- **Side by side.** Build the old version in a separate worktree:

  ```bash
  git worktree add <scratch>/old <base-sha> --detach
  ```

  Serve both on free ports. Seed identical local KV fixtures into each with
  `wrangler kv key put --local --binding GUESTBOOK`; that keeps timestamps and
  entries identical. Never use `--remote`, and never delete `.wrangler/`.
- **HTTP contract matrix, local only.** Cover:
  - `GET` / `HEAD` `/`, plain and with `sec-fetch-mode: navigate`;
  - the styled 404;
  - form `POST` → 303 (`queued`, `error`, `deleted`) with `cache-control: no-store`;
  - JSON 202/400, 405 with `allow`;
  - `DELETE /api/entries/<key>`: 503 with no `ADMIN_TOKEN`, 401 with a wrong or missing bearer, 200/400 with a local `.dev.vars` token;
  - the missing-binding 503 (a wrangler config copy without `[[kv_namespaces]]`);
  - escaping of `<`, `&` and `"` in entry text and in `aria-label`.

  Compare the results field by field against the old version.
- **Computed-style and pixel diff** at 375/540/580/1280 px (both sides of the
  560px breakpoint) on the home page with entries, the notice/error states and
  the 404. If fonts differ, re-run with one font pinned on both sides to prove
  nothing else moved. Also compare the textarea focus ring, button hovers and
  Tab order.
- **No-JS.** With JavaScript disabled, post and delete through the forms; the
  page must ship zero `<script>`.
- `zfb wind audit`: every markup class should be an ordinary/unrecognized
  authored class. Its `auditInfo` diagnostics come from CSS text inside the
  `CRITICAL_CSS` string, and its `file:N` locations are byte offsets, not
  lines (zudo-front-builder#3370).
- A fresh `pnpm install --frozen-lockfile` + typecheck + build in a clean
  `git worktree`, plus `pnpm why preact` (must be empty).

## Step 6 — Report

Summarize: versions traversed, notable upstream changes per release (one line
each), adaptations made (or "none needed"), and verification results.
