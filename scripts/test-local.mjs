import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

export const fixture = {
  key: "entry:2026-01-02T03:04:05.000Z:fixture",
  createdAt: "2026-01-02T03:04:05.000Z",
  message: '<hello> & "guest"',
};
const token = "local-test-admin-only";
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((done) => server.close(done));
  return port;
}

export async function startWorker(root, { binding = true, admin = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "guestbook-local-"));
  // Keep production routes, IDs and secrets out of this disposable local fixture.
  let config = (await readFile(join(root, "wrangler.toml"), "utf8"))
    .split("[[routes]]")[0]
    .replace('main = "./dist/_worker.js"', `main = ${JSON.stringify(join(root, "dist/_worker.js"))}`)
    .replace('directory = "./dist"', `directory = ${JSON.stringify(join(root, "dist"))}`)
    .replace(/^id = ".*"$/m, 'id = "00000000000000000000000000000000"');
  if (!binding) config = config.split("[[kv_namespaces]]")[0];
  await writeFile(join(dir, "wrangler.toml"), config);
  await writeFile(join(dir, ".dev.vars"), admin ? `ADMIN_TOKEN=${token}\n` : "");
  const env = { ...process.env, WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: join(dir, "wrangler.log") };
  for (const key of Object.keys(env)) {
    if (/^(CLOUDFLARE_|CF_|WRANGLER_API_)/.test(key)) delete env[key];
  }
  const cli = join(root, "node_modules/wrangler/bin/wrangler.js");
  async function command(args) {
    const child = spawn(process.execPath, [cli, ...args], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    child.stdout.on("data", (data) => (log += data));
    child.stderr.on("data", (data) => (log += data));
    const [code] = await once(child, "exit");
    assert.equal(code, 0, log);
  }
  if (binding) {
    await command(["kv", "key", "put", fixture.key, JSON.stringify(fixture), "--binding", "GUESTBOOK", "--local", "--config", join(dir, "wrangler.toml"), "--persist-to", join(dir, "state")]);
  }
  const port = await freePort();
  const child = spawn(process.execPath, [cli, "dev", "--local", "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(await freePort()), "--config", join(dir, "wrangler.toml"), "--persist-to", join(dir, "state")], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
  let log = "";
  child.stdout.on("data", (data) => (log += data));
  child.stderr.on("data", (data) => (log += data));
  const closed = once(child, "exit");
  const base = `http://127.0.0.1:${port}`;
  const stop = async () => {
    if (child.exitCode === null) {
      if (process.platform === "win32") child.kill();
      else process.kill(-child.pid, "SIGTERM");
      await closed;
    }
    await writeFile(join(dir, "server.log"), log);
  };
  try {
    for (let i = 0; i < 150; i++) {
      assert.equal(child.exitCode, null, log);
      try { await http(base, "/"); return { base, dir, stop }; } catch { await delay(200); }
    }
    throw new Error(`Local Worker did not start: ${log}`);
  } catch (error) { await stop(); throw error; }
}

export function http(base, path, { method = "GET", headers = {}, body } = {}) {
  assert.equal(new URL(base).hostname, "127.0.0.1", "Tests only accept loopback URLs");
  return new Promise((done, reject) => {
    const req = request(new URL(path, base), { method, headers, timeout: 5000 }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => done({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Local request timed out")));
    req.end(body);
  });
}

export async function contracts(base) {
  const results = [];
  async function check(label, path, options, status, expected = {}) {
    const response = await http(base, path, options);
    assert.equal(response.status, status, `${label}: ${response.text}`);
    for (const [key, value] of Object.entries(expected)) assert.equal(response.headers[key], value, label);
    results.push({ label, status, ...Object.fromEntries(Object.keys(expected).map((key) => [key, response.headers[key]])) });
    return response;
  }
  for (const navigate of [false, true]) {
    for (const method of ["GET", "HEAD"]) {
      const response = await check(`${method} home navigate=${navigate}`, "/", { method, headers: navigate ? { "sec-fetch-mode": "navigate" } : {} }, 200);
      if (method === "HEAD") assert.equal(response.text, "");
      else {
        assert.match(response.text, /Guestbook/);
        assert.match(response.text, /&lt;hello&gt; &amp; &quot;guest&quot;/);
        assert.match(response.text, /aria-label="Delete entry: &lt;hello&gt; &amp; &quot;guest&quot;"/);
        assert.doesNotMatch(response.text, /<script\b/i);
      }
    }
  }
  const missing = await check("styled 404", "/missing", { headers: { "sec-fetch-mode": "navigate" } }, 404);
  assert.match(missing.text, /stylesheet/);
  const list = await check("JSON list", "/api/entries", {}, 200, { "cache-control": "no-store" });
  assert.deepEqual(JSON.parse(list.text).entries, [fixture]);
  await check("home method", "/", { method: "PUT" }, 405, { allow: "GET, HEAD, POST" });
  await check("API method", "/api/entries", { method: "PUT" }, 405, { allow: "GET, POST", "cache-control": "no-store" });
  const keyPath = `/api/entries/${encodeURIComponent(fixture.key)}`;
  await check("delete method", keyPath, {}, 405, { allow: "DELETE", "cache-control": "no-store" });
  for (const authorization of ["", "Bearer wrong"]) await check(`unauthorized ${authorization}`, keyPath, { method: "DELETE", headers: { authorization } }, 401, { "cache-control": "no-store" });
  await check("invalid key", "/api/entries/invalid", { method: "DELETE", headers: { authorization: `Bearer ${token}` } }, 400, { "cache-control": "no-store" });
  for (const body of ['{', '{}', '{"message":""}', JSON.stringify({ message: "x".repeat(241) })]) {
    await check(`invalid JSON ${body.slice(0, 30)}`, "/api/entries", { method: "POST", headers: { "content-type": "application/json" }, body }, 400, { "cache-control": "no-store" });
  }
  const form = (fields) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });
  await check("empty form", "/", form({ message: "" }), 303, { location: "/?error=Message+is+required.", "cache-control": "no-store" });
  await check("form queued", "/", form({ message: "form entry" }), 303, { location: "/?queued=1", "cache-control": "no-store" });
  const queued = await check("JSON queued", "/api/entries", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "JSON entry" }) }, 202, { "cache-control": "no-store" });
  const entry = JSON.parse(queued.text).entry;
  let entries;
  for (let i = 0; i < 50; i++) {
    entries = JSON.parse((await http(base, "/api/entries")).text).entries;
    if (entries.some((item) => item.key === entry.key) && entries.some((item) => item.message === "form entry")) break;
    await delay(100);
  }
  assert(entries.some((item) => item.key === entry.key), "waitUntil JSON write persisted");
  assert(entries.some((item) => item.message === "form entry"), "waitUntil form write persisted");
  const deleted = await check("admin delete", `/api/entries/${encodeURIComponent(entry.key)}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } }, 200, { "cache-control": "no-store" });
  assert.deepEqual(JSON.parse(deleted.text), { ok: true, deleted: entry.key });
  await check("form delete", "/", form({ delete: fixture.key }), 303, { location: "/?deleted=1", "cache-control": "no-store" });
  entries = JSON.parse((await http(base, "/api/entries")).text).entries;
  assert(!entries.some((item) => [entry.key, fixture.key].includes(item.key)), "deletions persisted");
  return results;
}

export async function run(root) {
  const results = [];
  for (const options of [{}, { admin: false }, { binding: false }]) {
    const worker = await startWorker(root, options);
    try {
      if (options.admin === false) {
        const response = await http(worker.base, `/api/entries/${encodeURIComponent(fixture.key)}`, { method: "DELETE" });
        assert.equal(response.status, 503);
        assert.equal(JSON.parse(response.text).error, "ADMIN_TOKEN is not configured.");
        results.push({ label: "missing admin", status: 503 });
      } else if (options.binding === false) {
        for (const path of ["/", "/api/entries", `/api/entries/${encodeURIComponent(fixture.key)}`]) {
          const response = await http(worker.base, path, path.includes("entry%3A") ? { method: "DELETE", headers: { authorization: `Bearer ${token}` } } : {});
          assert.equal(response.status, 503);
          assert.match(response.text, /GUESTBOOK KV binding is not configured/);
          results.push({ label: `missing binding ${path}`, status: 503 });
        }
      } else results.push(...await contracts(worker.base));
    } finally { await worker.stop(); }
  }
  console.log(JSON.stringify(results, null, 2));
  console.log(`PASS: ${results.length} local Worker/KV contracts`);
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await run(resolve(process.argv[2] ?? "."));
}
