# Cloudflare setup

An ordered, from-zero walkthrough that takes this repo from "never deployed" to
"live on Workers with a working KV guestbook".

**Both gates are now cleared** — the KV namespace is provisioned and its real
id is committed in `wrangler.toml`, so the `deploy` job runs and the site is live
at https://zfb-example-kv-guestbook.takazudomodular.com/.

The walkthrough below is kept as the from-zero reference (and for re-provisioning
if the namespace is ever recreated). The `deploy` job self-skips while *either*
of these is unmet:

1. `CLOUDFLARE_API_TOKEN` exists as a repo secret (step 2), and
2. `wrangler.toml` holds a real KV namespace id (step 3).

The `build` job runs regardless and needs no credentials, so CI stays green
throughout.

This repo has the most setup steps of the `zfb-example-*` family — Workers
static assets, a KV namespace, *and* a Worker-side admin secret. Do the steps in
order; each one depends on the last.

## 1. Create (or reuse) the Cloudflare API token

All nine `zfb-example-*` repos share **one** account-scoped token. If you have
already created it for another example site, skip to step 2 and reuse it — the
family-wide guide covers creating it once and reusing it everywhere:

<https://github.com/Takazudo/zfbex-tweaker/blob/main/docs/cloudflare-shared-token-and-env-setup.md>

To create it fresh: Cloudflare dashboard → My Profile → API Tokens → Create
Custom Token, with these permissions:

| Type    | Resource            | Level |
| ------- | ------------------- | ----- |
| Account | Workers Scripts     | Edit  |
| Account | Workers KV Storage  | Edit  |
| Account | Account Settings    | Read  |
| Zone    | Workers Routes      | Edit  |

Set **Account Resources → Include → (your account)**, and for the Zone row set
**Zone Resources → Include → takazudomodular.com**.

The Zone row is required because this repo serves a custom domain
(`zfb-example-kv-guestbook.takazudomodular.com`, declared as a `[[routes]]`
entry in `wrangler.toml`). Without it `wrangler deploy` uploads the Worker and
then fails on the route step, leaving the domain unattached.

A shared token must carry the union of every repo's permissions, so if you are
extending an existing one, confirm **Workers KV Storage: Edit** is present. It
is the permission this repo adds over the plain static examples.

You also need your **account id**: dashboard → Workers & Pages → the account id
shown in the right-hand sidebar.

## 2. Set the two GitHub Actions secrets

Both are repo secrets under **Settings → Secrets and variables → Actions**:

| Secret | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | the token from step 1 |
| `CLOUDFLARE_ACCOUNT_ID` | target Cloudflare account id |

From the CLI:

```bash
gh secret set CLOUDFLARE_API_TOKEN --repo Takazudo/zfb-example-kv-guestbook
gh secret set CLOUDFLARE_ACCOUNT_ID --repo Takazudo/zfb-example-kv-guestbook
```

Each command prompts for the value, so the secret never lands in your shell
history. Verify with:

```bash
gh secret list --repo Takazudo/zfb-example-kv-guestbook
```

## 3. Provision the KV namespace and commit its real id

This step is required — the deploy job refuses to run while the placeholder
remains. **Already done**: the id is committed, provisioned by the
`KV bootstrap (one-time)` workflow.

Prefer that workflow over running this locally — it executes
`wrangler kv namespace create` in CI, where the `CLOUDFLARE_*` secrets actually
live, and prints the id as a step summary plus a downloadable artifact:

```bash
gh workflow run kv-bootstrap.yml --ref main
gh run watch <run-id>
gh run download <run-id> -n kv-id
```

To do it locally instead you need your own Cloudflare credentials:

```bash
pnpm exec wrangler kv namespace create zfb-example-kv-guestbook
```

Wrangler prints an `id`. Paste it into the `[[kv_namespaces]]` block in
`wrangler.toml`, replacing the placeholder and leaving the binding name alone:

```toml
[[kv_namespaces]]
binding = "GUESTBOOK"
id = "the-id-wrangler-just-printed"
```

The binding must stay `GUESTBOOK` — `lib/kv.ts` looks the namespace up by that
exact name. Then commit and push, because the deploy job reads `wrangler.toml`
from the repo, not from your working copy:

```bash
git add wrangler.toml
git commit -m "chore: set real KV namespace id"
git push origin main
```

## 4. No secret needed — deletion is open

This step used to set an `ADMIN_TOKEN` Worker secret that gated
`DELETE /api/entries/<key>`. It is gone: this is a throwaway demo, so anyone can
delete any entry, and every entry carries a Delete button in the UI.

Nothing to do here. If you set `ADMIN_TOKEN` on a Worker earlier, it is now
unused and can be removed from the dashboard (Settings → Variables and secrets).

## 5. Trigger the first deploy

With both gates cleared, any push to `main` deploys. The step 3 push may already
have done it — check first:

```bash
gh run list --repo Takazudo/zfb-example-kv-guestbook --limit 3
gh run watch --repo Takazudo/zfb-example-kv-guestbook
```

If you need to trigger one without a code change, push an empty commit:

```bash
git commit --allow-empty -m "chore: trigger first Cloudflare deploy"
git push origin main
```

To deploy from your machine instead, build first — `wrangler.toml` points
`main` at `./dist/_worker.js`, which does not exist until then:

```bash
pnpm build
pnpm exec wrangler deploy
```

The Worker lands on its custom domain:

<https://zfb-example-kv-guestbook.takazudomodular.com>

and, because `wrangler.toml` sets `workers_dev = true`, also stays reachable at:

<https://zfb-example-kv-guestbook.takazudo.workers.dev>

The deploy job runs `pnpm smoke` immediately afterwards, which asserts the
custom domain serves the guestbook and that the KV read path works. It exits
`0` with a notice while the domain is not reachable yet, so a first deploy that
lands before DNS propagates does not go red.

## 6. Verify the deployment

Run these against the deployed host. They are the README's examples pointed at
production instead of `localhost:4321`.

```bash
BASE=https://zfb-example-kv-guestbook.takazudomodular.com
```

**The page renders** — expect `200` and the guestbook form in the HTML:

```bash
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/"
```

**Reads work** — expect `{"ok":true,"entries":[...],...}`. A `503` here means
the `GUESTBOOK` binding is not reaching the Worker:

```bash
curl -s "$BASE/api/entries"
```

**Writes work** — expect `202` with `"queued":true`. The write goes through
`ctx.waitUntil()`, so the response returns before KV settles:

```bash
curl -s -X POST "$BASE/api/entries" \
  -H "content-type: application/json" \
  --data '{"message":"hello from curl"}'
```

Read back after a moment and confirm the entry appears, then copy its `key`:

```bash
sleep 5 && curl -s "$BASE/api/entries"
```

**Delete works** — expect `{"ok":true,"deleted":"..."}`. Use the key from the
read above; no authentication is required:

```bash
ENTRY_KEY='entry:2026-07-10T00:00:00.000Z:replace'
ENCODED_KEY=$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$ENTRY_KEY")
curl -X DELETE "$BASE/api/entries/$ENCODED_KEY"
```

If all five pass, the setup is complete.

## Troubleshooting

**The deploy job was skipped.** Two independent gates cause this, and the run's
annotation says which one fired. Either `CLOUDFLARE_API_TOKEN` is unset (step 2)
or `wrangler.toml` still matches `REPLACE_WITH` (step 3). Clearing one gate is
not enough — the job checks both.

**`503` from `GET`/`POST /api/entries` or the homepage.** The `GUESTBOOK` KV
binding is not reaching the Worker. Check that the `[[kv_namespaces]]` block has
a real id, that `binding` is still spelled `GUESTBOOK`, and that the deploy which
carried the change actually succeeded. The same `503` is expected under
`pnpm dev`, which has no Cloudflare bindings at all — use `pnpm build` plus
`pnpm preview` for local binding-backed testing.

**`401` or `503` from `DELETE /api/entries/<key>`.** Not possible any more —
the route is unauthenticated. If you see one, the Worker is running an older
version from before deletion was opened up; redeploy.

**A just-written entry does not appear.** Expected, briefly. `POST` hands
`KV.put(...)` to `ctx.waitUntil()` and returns `202` before the write settles,
and KV is eventually consistent on top of that — so an immediate redirect or
`GET /api/entries` can legitimately miss it. Wait a few seconds and read again.
Treat it as a real failure only if the entry never shows up.

**A `400` from `POST`.** The submission had no usable `message` field. The
endpoint accepts JSON, form-encoded, or plain text bodies, but the message
itself must be present and non-empty.
