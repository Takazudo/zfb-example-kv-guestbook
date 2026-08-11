#!/usr/bin/env node
/**
 * Read-only post-deploy smoke test for the live guestbook.
 *
 * A deploy that succeeds only proves the Worker uploaded. It cannot prove that
 * the custom domain resolves to it, that TLS is valid for that hostname, or
 * that the GUESTBOOK KV binding actually reaches the running Worker — those are
 * only observable against the deployed origin, which is why this runs after
 * deploy rather than as a unit test.
 *
 * Read-only by design: a post-deploy check must never mutate production data,
 * so this issues GET requests only and never posts a guestbook entry.
 *
 * Usage:
 *   node scripts/smoke.mjs                       # production custom domain
 *   node scripts/smoke.mjs http://localhost:4321 # a local `pnpm preview`
 *   SMOKE_BASE_URL=https://… node scripts/smoke.mjs
 *   SMOKE_REQUIRE_LIVE=1 node scripts/smoke.mjs  # "not ready yet" becomes a failure
 */

import { request as httpsRequest } from "node:https";

const DEFAULT_BASE_URL = "https://zfb-example-kv-guestbook.takazudomodular.com";

/**
 * Network failures that mean "Cloudflare is not wired up yet" rather than
 * "the site is broken". The house rule is that this repo never shows a red
 * deploy before it is provisioned, so these exit 0 with a notice.
 *
 * ENETUNREACH / EHOSTUNREACH are the attach-time propagation window rather than
 * a missing domain: Cloudflare publishes the AAAA record before the A record,
 * and GitHub-hosted runners have no IPv6 route, so for a few minutes a fully
 * working site is reachable only over an address family the runner cannot use.
 *
 * ERR_TLS_CERT_ALTNAME_INVALID is that same window seen through TLS — until the
 * hostname's certificate is issued, the edge answers with one that does not
 * cover it.
 */
const NOT_PROVISIONED_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

/**
 * Certificate failures that veto a skip even when a not-ready code is reported
 * alongside them. A freshly issued edge certificate is never expired and never
 * untrusted, so these can only mean an established domain broke. The veto
 * matters because a dual-stack host fails differently per address family — no
 * IPv6 route plus a broken certificate over IPv4 — and the broken half is the
 * verdict.
 */
const MUST_FAIL_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

/**
 * Opt-in strictness for the day this site is live: every skip above becomes an
 * ordinary failure. Deliberately unset in CI here — the KV namespace id is still
 * a REPLACE_WITH_* placeholder, so the domain is intentionally not attached and
 * "not reachable" is the correct steady state for this repo.
 */
const REQUIRE_LIVE = /^(1|true)$/i.test(process.env.SMOKE_REQUIRE_LIVE ?? "");

const REQUEST_TIMEOUT_MS = 15_000;
/** A freshly deployed Worker can 5xx briefly while it propagates to every PoP. */
// This runs seconds after `wrangler deploy` returns, but that call completes when
// the upload finishes, not when the new version is serving everywhere. A ~10s
// budget was too short: the first post-fix deploy went red against a Worker that
// was correct and live moments later. Wide enough to ride out version rollout,
// still bounded so a genuinely broken deploy fails rather than hangs.
const ATTEMPTS = 6;
const RETRY_DELAY_MS = 10_000;

const baseUrl = (process.argv[2] ?? process.env.SMOKE_BASE_URL ?? DEFAULT_BASE_URL).replace(
  /\/+$/,
  "",
);

/** `::notice::` / `::error::` are GitHub Actions annotation commands; harmless locally. */
function notice(message) {
  console.log(`::notice::${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function get(path) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "GET",
    redirect: "follow",
    headers: { "user-agent": "zfb-example-kv-guestbook-smoke" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return { response, body: await response.text() };
}

/**
 * A request carrying `sec-fetch-mode: navigate`, i.e. what a browser sends when
 * a person opens the URL. This MUST NOT use fetch(): `Sec-` prefixed names are
 * forbidden header names in the Fetch spec, so undici silently drops them and
 * the request goes out as an ordinary one. That is not a cosmetic difference —
 * Cloudflare's asset layer applies `not_found_handling` only to NAVIGATION
 * requests, so a plain fetch falls through to the Worker and renders fine while
 * every real visitor gets the 404 page. This check exists because that exact
 * bug shipped and passed a fetch-based smoke test.
 *
 * node:https writes the headers verbatim, so it can reproduce a real navigation.
 */
function navigationGet(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const request = httpsRequest(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: "GET",
        headers: {
          "user-agent": "zfb-example-kv-guestbook-smoke",
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "sec-fetch-mode": "navigate",
          "sec-fetch-dest": "document",
          "sec-fetch-site": "none",
          "upgrade-insecure-requests": "1",
        },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      },
    );
    request.on("timeout", () => request.destroy(new Error("navigation request timed out")));
    request.on("error", reject);
    request.end();
  });
}

/**
 * fetch wraps the OS-level failure, so dig out every real code beneath it.
 *
 * Two shapes have to be handled. A single-address host nests it as
 * TypeError -> Error(code). A dual-stack host (IPv6 + IPv4) nests it as
 * TypeError -> AggregateError -> errors[]; the AggregateError carries a
 * top-level `code` only when every sub-error agrees, so the errors array has to
 * be searched too. Missing that case would turn an intended self-skip into a red
 * deploy, which is the exact outcome this script exists to avoid.
 *
 * Every code is collected rather than the first match, because the two legs of a
 * dual-stack attempt can fail for unrelated reasons and the verdict depends on
 * seeing both.
 */
function errorCodes(error, depth = 0, found = []) {
  if (error == null || depth > 10) return found;
  if (typeof error.code === "string") found.push(error.code);
  if (Array.isArray(error.errors)) {
    for (const nested of error.errors) errorCodes(nested, depth + 1, found);
  }
  return errorCodes(error.cause, depth + 1, found);
}

/** The code to skip on, or null when this failure has to be reported as red. */
function notProvisionedCode(codes) {
  if (codes.some((code) => MUST_FAIL_CODES.has(code))) return null;
  return codes.find((code) => NOT_PROVISIONED_CODES.has(code)) ?? null;
}

async function runChecks() {
  const failures = [];
  const check = (condition, message) => {
    if (!condition) failures.push(message);
  };

  const home = await get("/");
  check(home.response.status === 200, `GET / expected 200, got ${home.response.status}`);
  const homeType = home.response.headers.get("content-type") ?? "";
  check(homeType.includes("text/html"), `GET / expected an HTML content-type, got "${homeType}"`);
  check(
    home.body.includes("<title>zfb KV guestbook</title>"),
    "GET / did not render the guestbook <title>",
  );
  check(
    home.body.includes('class="page-title">Guestbook'),
    "GET / did not render the Guestbook heading",
  );
  check(home.body.includes('id="entries-title"'), "GET / did not render the Entries section");

  // The KV read path. pages/index.tsx is `prerender = false` and returns a
  // text/plain 503 when the GUESTBOOK binding is missing or the KV list throws,
  // so reaching either rendered state above proves the read completed. An empty
  // guestbook is a valid passing state, hence the either/or.
  //
  // Match `class="entry-list"` rather than the bare string: the layout inlines
  // critical CSS containing `.entry-list`, so `entry-list` alone is always
  // present and would pass even on a page that rendered no entries section.
  check(
    home.body.includes('class="entry-list"') || home.body.includes("No entries yet."),
    "GET / rendered neither an entry list nor the empty-guestbook message — the KV read path did not complete",
  );

  // What a person actually gets. The checks above use fetch(), which cannot send
  // `sec-fetch-mode: navigate` (a forbidden header name, silently dropped), so
  // they exercise a request shape no browser ever produces. Cloudflare's asset
  // layer applies `not_found_handling` only to navigation requests, so the two
  // can disagree completely: this site once served a correct 200 to fetch() and
  // the 404 page to every human visitor, and the suite stayed green.
  const nav = await navigationGet("/");
  check(
    nav.status === 200,
    `A browser navigation to / expected 200, got ${nav.status} — the asset layer is answering before the Worker (check run_worker_first)`,
  );
  check(
    nav.body.includes('class="page-title">Guestbook'),
    "A browser navigation to / did not render the Guestbook heading — it likely received the 404 page",
  );

  const api = await get("/api/entries");
  check(
    api.response.status === 200,
    `GET /api/entries expected 200, got ${api.response.status}`,
  );
  const apiType = api.response.headers.get("content-type") ?? "";
  check(
    apiType.includes("application/json"),
    `GET /api/entries expected a JSON content-type, got "${apiType}"`,
  );

  let payload;
  try {
    payload = JSON.parse(api.body);
  } catch {
    failures.push("GET /api/entries did not return parseable JSON");
  }
  if (payload !== undefined) {
    check(payload?.ok === true, `GET /api/entries returned ok=${JSON.stringify(payload?.ok)}`);
    check(
      Array.isArray(payload?.entries),
      "GET /api/entries did not return an entries array — the KV read path failed",
    );
  }

  return failures;
}

for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
  const lastAttempt = attempt === ATTEMPTS;
  try {
    const failures = await runChecks();
    if (failures.length === 0) {
      console.log(`Smoke test passed against ${baseUrl}`);
      process.exit(0);
    }
    if (lastAttempt) {
      console.log(`::error::Smoke test failed against ${baseUrl}`);
      for (const failure of failures) console.log(`::error::${failure}`);
      process.exit(1);
    }
    console.log(`Attempt ${attempt} found ${failures.length} problem(s); retrying…`);
  } catch (error) {
    const codes = errorCodes(error);
    const skipCode = notProvisionedCode(codes);
    if (skipCode && !REQUIRE_LIVE) {
      notice(
        `${baseUrl} is not reachable yet (${skipCode}) — skipping the smoke test. ` +
          "Attach the custom domain in Cloudflare, then re-run.",
      );
      process.exit(0);
    }
    // `fetch` reports every network failure as the same "fetch failed", so the
    // collected codes are the only thing that says which one it was.
    const detail = codes.length > 0 ? codes.join(", ") : (error?.message ?? error);
    if (lastAttempt) {
      console.log(`::error::Smoke test could not reach ${baseUrl}: ${detail}`);
      process.exit(1);
    }
    console.log(`Attempt ${attempt} failed (${detail}); retrying…`);
  }
  await sleep(RETRY_DELAY_MS);
}

// Unreachable today: the final attempt always exits from inside the loop. Kept
// so a future edit to that control flow fails loudly instead of falling out of
// the loop and exiting 0 with nothing checked.
console.log("::error::Smoke test ended without reaching a verdict");
process.exit(1);
