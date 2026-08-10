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
 */

const DEFAULT_BASE_URL = "https://zfb-example-kv-guestbook.takazudomodular.com";

/**
 * Network failures that mean "Cloudflare is not wired up yet" rather than
 * "the site is broken". The house rule is that this repo never shows a red
 * deploy before it is provisioned, so these exit 0 with a notice.
 *
 * TLS and certificate error codes are deliberately absent: a domain that
 * resolves but fails TLS is a real misconfiguration and must fail loudly.
 */
const NOT_PROVISIONED_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED"]);

const REQUEST_TIMEOUT_MS = 15_000;
/** A freshly deployed Worker can 5xx briefly while it propagates to every PoP. */
const ATTEMPTS = 3;
const RETRY_DELAY_MS = 5_000;

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
 * fetch wraps the OS-level failure, so dig for the real code.
 *
 * Two shapes have to be handled. A single-address host nests it as
 * TypeError -> Error(code). A dual-stack host (IPv6 + IPv4) nests it as
 * TypeError -> AggregateError -> errors[]; the AggregateError carries a
 * top-level `code` only when every sub-error agrees, so the errors array has to
 * be searched too. Missing that case would turn an intended self-skip into a red
 * deploy, which is the exact outcome this script exists to avoid.
 */
function notProvisionedCode(error, depth = 0) {
  if (error == null || depth > 10) return null;
  if (typeof error.code === "string" && NOT_PROVISIONED_CODES.has(error.code)) {
    return error.code;
  }
  if (Array.isArray(error.errors)) {
    for (const nested of error.errors) {
      const code = notProvisionedCode(nested, depth + 1);
      if (code) return code;
    }
  }
  return notProvisionedCode(error.cause, depth + 1);
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
    const code = notProvisionedCode(error);
    if (code) {
      notice(
        `${baseUrl} is not reachable yet (${code}) — skipping the smoke test. ` +
          "Attach the custom domain in Cloudflare, then re-run.",
      );
      process.exit(0);
    }
    if (lastAttempt) {
      console.log(`::error::Smoke test could not reach ${baseUrl}: ${error?.message ?? error}`);
      process.exit(1);
    }
    console.log(`Attempt ${attempt} failed (${error?.message ?? error}); retrying…`);
  }
  await sleep(RETRY_DELAY_MS);
}

// Unreachable today: the final attempt always exits from inside the loop. Kept
// so a future edit to that control flow fails loudly instead of falling out of
// the loop and exiting 0 with nothing checked.
console.log("::error::Smoke test ended without reaching a verdict");
process.exit(1);
