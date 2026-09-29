import DefaultLayout from "../layouts/default";
import {
  MESSAGE_MAX_LENGTH,
  createGuestbookEntry,
  getGuestbookContext,
  getGuestbookKv,
  listGuestbookEntries,
  isEntryKey,
  parseEntrySubmission,
  queueEntryWrite,
  type EntryKey,
  type EntryListResult,
} from "../lib/kv";

export const prerender = false;

export default async function HomePage() {
  const cf = getGuestbookContext();
  if (!cf) {
    return new Response("Cloudflare request context is unavailable.", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  const { request, env, ctx } = cf;
  const kv = getGuestbookKv(env);
  if (!kv) {
    return new Response("GUESTBOOK KV binding is not configured.", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  if (request.method === "POST") {
    // A delete arrives as the same form POST as a new entry, distinguished by a
    // `delete` field. Peek at a CLONE: parseEntrySubmission below consumes the
    // body, and a Request body can only be read once.
    const deleteKey = await readDeleteKey(request);
    if (deleteKey) {
      try {
        await kv.delete(deleteKey);
      } catch {
        return redirectTo("/", request, { error: "Entry could not be deleted." });
      }
      return redirectTo("/", request, { deleted: "1" });
    }

    const submission = await parseEntrySubmission(request);
    if (!submission.ok) {
      return redirectTo("/", request, { error: submission.error });
    }

    const entry = createGuestbookEntry(submission.message);
    queueEntryWrite(kv, entry, ctx);
    return redirectTo("/", request, { queued: "1" });
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", {
      status: 405,
      headers: {
        allow: "GET, HEAD, POST",
        "content-type": "text/plain; charset=utf-8",
      },
    });
  }

  let result: EntryListResult;
  try {
    result = await listGuestbookEntries(kv);
  } catch {
    return new Response("Guestbook entries could not be loaded.", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  const url = new URL(request.url);
  const notice =
    url.searchParams.get("queued") === "1"
      ? "Entry queued. It may take a moment to appear."
      : url.searchParams.get("deleted") === "1"
        ? "Entry deleted."
        : null;
  const error = url.searchParams.get("error");

  return (
    <DefaultLayout>
      <div class="stack">
        <section>
          <h1 class="page-title">Guestbook</h1>
          <p class="muted">
            A working demo of zfb + Cloudflare Workers KV — server-rendered pages,
            real KV reads and writes, deployed on Workers.
          </p>
          <p class="muted">
            Post anything, and delete any entry with the button beside it. Deletion is
            open here so you can try the whole loop. A real guestbook would not do
            that, which is why the <code>DELETE /api/entries/&lt;key&gt;</code> endpoint
            below still requires an admin token — that endpoint is the part worth
            copying.
          </p>
        </section>

        {notice ? <div class="notice">{notice}</div> : null}
        {error ? <div class="error">{error}</div> : null}

        <section class="panel" aria-labelledby="sign-title">
          <h2 class="section-title" id="sign-title">
            Sign the guestbook
          </h2>
          <form class="entry-form" method="post" action="/">
            <label for="message">Message</label>
            <textarea
              id="message"
              name="message"
              maxlength={MESSAGE_MAX_LENGTH}
              required
              rows={4}
            />
            <div class="form-row">
              <span class="muted">{MESSAGE_MAX_LENGTH} characters max</span>
              <button type="submit">Post entry</button>
            </div>
          </form>
        </section>

        <section class="panel" aria-labelledby="entries-title">
          <h2 class="section-title" id="entries-title">
            Entries
          </h2>
          {result.entries.length > 0 ? (
            <ul class="entry-list">
              {result.entries.map((entry) => (
                <li class="entry" key={entry.key}>
                  <p>{entry.message}</p>
                  <div class="entry-meta">
                    <time datetime={entry.createdAt}>{formatDate(entry.createdAt)}</time>
                    <code>{entry.key}</code>
                    <form class="entry-delete" method="post" action="/">
                      <input type="hidden" name="delete" value={entry.key} />
                      <button type="submit" aria-label={`Delete entry: ${entry.message}`}>
                        Delete
                      </button>
                    </form>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p class="muted">No entries yet.</p>
          )}
        </section>

        <section class="panel" aria-labelledby="api-title">
          <h2 class="section-title" id="api-title">
            API
          </h2>
          <p class="muted">
            <code>DELETE</code> requires <code>Authorization: Bearer &lt;ADMIN_TOKEN&gt;</code>.
            The Delete buttons above post to this page instead, which is why they work
            without one.
          </p>
          <div class="api-list">
            <code>GET /api/entries</code>
            <code>POST /api/entries</code>
            <code>DELETE /api/entries/&lt;key&gt;</code>
          </div>
        </section>
      </div>
    </DefaultLayout>
  );
}

/**
 * The entry key a delete form submitted, or null when this POST is a new entry.
 *
 * Reads a CLONE so the original body stays unread for parseEntrySubmission — a
 * Request body is a stream and can only be consumed once. A JSON POST has no
 * form body at all, so the parse throws and we fall through to the entry path.
 */
async function readDeleteKey(request: Request): Promise<EntryKey | null> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (
    !contentType.includes("application/x-www-form-urlencoded") &&
    !contentType.includes("multipart/form-data")
  ) {
    return null;
  }

  let form: FormData;
  try {
    form = await request.clone().formData();
  } catch {
    return null;
  }

  const candidate = form.get("delete");
  if (typeof candidate !== "string" || !isEntryKey(candidate)) return null;
  return candidate;
}

function redirectTo(pathname: string, request: Request, params: Record<string, string>): Response {
  const url = new URL(pathname, request.url);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return new Response(null, {
    status: 303,
    headers: {
      location: `${url.pathname}${url.search}`,
      "cache-control": "no-store",
    },
  });
}

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(iso));
}
