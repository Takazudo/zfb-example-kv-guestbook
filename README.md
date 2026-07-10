# zfb-example-kv-guestbook

A compact zfb + Cloudflare Workers KV guestbook recipe. The homepage is a
server-rendered `prerender = false` route with a plain HTML form, and the same
KV helpers power JSON API endpoints.

## Local run

```bash
pnpm install
pnpm dev
pnpm build
pnpm preview
```

`pnpm dev` is useful for normal zfb authoring, but Cloudflare bindings are not
available there. Binding-backed routes return a controlled `503` instead of
crashing. Use `pnpm build` followed by `pnpm preview` for the local Worker and
KV simulation.

Wrangler stores local KV state under `.wrangler/`. Delete that directory when
you want a fresh local namespace.

## Provision Cloudflare resources

Create a KV namespace:

```bash
pnpm exec wrangler kv namespace create zfb-example-kv-guestbook
```

Paste the printed namespace ID into `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "GUESTBOOK"
id = "REPLACE_WITH_KV_NAMESPACE_ID"
```

Set the admin delete token as a secret:

```bash
pnpm exec wrangler secret put ADMIN_TOKEN
```

For local `pnpm preview`, put a local token in `.dev.vars`:

```dotenv
ADMIN_TOKEN=local-dev-token
```

Deploy after building:

```bash
pnpm build
pnpm exec wrangler deploy
```

## Endpoints

- `GET /` renders the guestbook and the no-JS form.
- `POST /` handles the form, queues the KV write, and redirects back to `/`.
- `GET /api/entries` returns the current bounded entry window as JSON.
- `POST /api/entries` accepts JSON, form, or text input with a `message`.
- `DELETE /api/entries/<entry-key>` deletes an entry when the request includes
  `Authorization: Bearer <ADMIN_TOKEN>`.

Example JSON write:

```bash
curl -X POST http://localhost:8787/api/entries \
  -H "content-type: application/json" \
  --data '{"message":"hello from curl"}'
```

Example admin delete:

```bash
ENTRY_KEY='entry:2026-07-10T00:00:00.000Z:replace'
ENCODED_KEY=$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$ENTRY_KEY")
curl -X DELETE "http://localhost:8787/api/entries/$ENCODED_KEY" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

## KV behavior

Writes use keys shaped as `entry:<ISO timestamp>:<random hex>`, so the key name
contains the creation time and remains sortable. Each entry uses
`expirationTtl`, currently 90 days, so the namespace does not grow forever.

`POST /api/entries` and the homepage form pass `KV.put(...)` to
`ctx.waitUntil()` and return before the write settles. That keeps the response
fast, but KV is eventually consistent, so a redirect or immediate
`GET /api/entries` may not show the new entry yet.

The read path calls `KV.list({ prefix, limit })` first, then reads only a capped
number of keys with per-key `KV.get(...)` calls. The cap keeps the recipe under
Workers subrequest budgets and avoids opening an unbounded number of KV
connections for a single request.

If the `GUESTBOOK` binding is missing, routes return a clear `503` JSON or text
response. If `ADMIN_TOKEN` is missing, the delete endpoint returns a clear
`503`; missing or wrong bearer tokens return `401`.

## Continuous deployment (GitHub Actions)

This repo ships `.github/workflows/deploy.yml`:

- **build** runs on every push and PR — `pnpm install`, `pnpm typecheck`,
  `pnpm build`. It needs no Cloudflare credentials, so CI is green immediately.
- **deploy** runs on push to `main` and calls `wrangler deploy`. It self-skips
  until the secrets below are set, so a fresh repo never shows a red deploy.

Add these under **Settings → Secrets and variables → Actions**:

| Secret | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | API token with Account · Workers Scripts: Edit and Workers KV Storage: Edit |
| `CLOUDFLARE_ACCOUNT_ID` | target Cloudflare account id |

Before deploy can run, create the KV namespace and commit its real id into `wrangler.toml` — the deploy job self-skips while the `REPLACE_WITH_KV_NAMESPACE_ID` placeholder remains (see **Provision Cloudflare resources** above). `ADMIN_TOKEN` is a Worker secret set with `wrangler secret put`, not a GitHub secret.

### Cloudflare API token permissions

The `CLOUDFLARE_API_TOKEN` repo secret is an **Account**-scoped custom token
(Cloudflare dashboard → My Profile → API Tokens → Create Custom Token) with
these permissions:

- **Workers Scripts** — Edit
- **Workers KV Storage** — Edit
- **Account Settings** — Read

Set **Account Resources → Include → (your account)**. No Zone permissions are
needed — this repo deploys to a `*.workers.dev` host, not a custom domain. A
single token can be shared across all `zfb-example-*` repos if it carries the
union of every repo's permissions.
