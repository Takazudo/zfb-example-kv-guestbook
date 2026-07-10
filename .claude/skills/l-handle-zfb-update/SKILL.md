---
name: l-handle-zfb-update
description: >-
  Update the zfb upstream dependency (the @takazudo/zfb* packages) in this
  example (kv-guestbook) to the latest "next" dist-tag, review what changed
  upstream between versions, and adapt this project's code if a change touches a
  surface it uses. Use when: (1) User says 'update zfb', 'bump zfb', 'zfb
  update', or 'handle zfb update', (2) A new zfb next release is out and this
  example should track it.
user-invocable: true
argument-hint: "[target-version, e.g. 0.1.0-next.80 — omit to use latest next]"
---

# Handle zfb Update — kv-guestbook

This is a Cloudflare Workers KV guestbook: a server-rendered `prerender = false`
homepage with a no-JS HTML form, plus JSON API endpoints and an admin delete, all
backed by the same KV helpers. It uses a KV namespace binding (`GUESTBOOK`) and an
`ADMIN_TOKEN` secret.

Bump every `@takazudo/*` package this repo depends on to the latest `next`
prerelease (kept in lockstep on one version), review what changed upstream, and
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
TARGET=${1:-$(npm view @takazudo/zfb dist-tags.next)}
```

- Always resolve the target from the `next` dist-tag, never `latest` — this repo
  tracks the zfb prerelease line.
- If `CURRENT` == `TARGET`: report "already at the latest next (<version>)" and STOP.
- If an explicit target is older than `CURRENT`, that is a downgrade — stop and
  confirm first.

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
| `defineConfig` schema | `zfb.config.ts` — framework / adapter / tailwind settings |
| Cloudflare adapter + `getCloudflareContext()` (KV `GUESTBOOK`) | `lib/kv.ts`, `pages/index.tsx`, `pages/api/entries.tsx`, `pages/api/entries/[key].tsx` |
| API route contract (`export const prerender = false`) | `pages/index.tsx` (POST form), `pages/api/entries.tsx`, `pages/api/entries/[key].tsx` |
| Dynamic route contract (`[key]` param) | `pages/api/entries/[key].tsx` |
| Layouts | `layouts/default.tsx` |
| Tailwind / CSS pipeline | `styles/global.css` |
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
pnpm build       # pages build cleanly, adapter writes dist/_worker.js + dist/.assetsignore
pnpm typecheck   # zfb check passes
```

Cloudflare bindings are unavailable under `zfb build` / `zfb dev`; binding-backed
routes return a controlled `503`, which is expected. Exercise real KV with
`pnpm build` then `pnpm exec wrangler dev` (local KV state lives under
`.wrangler/`), per the README.

## Step 6 — Report

Summarize: versions traversed, notable upstream changes per release (one line
each), adaptations made (or "none needed"), and verification results.
