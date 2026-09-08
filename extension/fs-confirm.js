// Open File Bridge — out-of-band confirmation gate (Stage 3, 2026-09-07).
//
// Dandan's ask: destructive ops (delete + overwrite by default) must get
// an OUT-OF-CHAT confirmation — a popup rendered by the extension INSIDE
// the Open WebUI page (the thing the desktop app can never do), like
// Claude Code / Codex permission prompts.
//
// DESIGN (non-blocking — the two hard pipe limits forbid waiting):
//   relay.js drops inflight ids after 120 s and MV3 SWs die at ~5 min,
//   so the write call NEVER waits for the click. Instead:
//     1. gated op → 403 {confirmation_required, confirm_id, hint}
//     2. SW pushes the popup to the requesting TAB (content script
//        confirm.js renders the card; relay.js stays byte-identical)
//     3. user clicks Approve/Deny → SW stores the verdict
//     4. model retries the SAME request (the skill teaches the loop);
//        the gate sees the grant and executes. Single-use, 5-min TTL.
//
// Scope (configurable in the settings UI, kv "confirm_scope"):
//   "off"            — no confirmations (v2.11 behavior)
//   "destructive"    — deletes only  (default per Dandan 2026-09-07:
//   "all"            — deletes + every overwrite
//                      default = "all")

"use strict";

const CONFIRM_TTL_MS = 5 * 60 * 1000; // pending asks auto-expire
const CONFIRM_GRANT_TTL_MS = 5 * 60 * 1000; // approved grant lifetime
const CONFIRM_SCOPE_DEFAULT = "all"; // "off" | "destructive" | "all"

// pending: id → {op, path, tabId, ts, verdict: null|"approved"|"denied"}
let CONFIRM_PENDING = new Map();

async function confirmScope() {
  const v = await kvGet("confirm_scope", CONFIRM_SCOPE_DEFAULT);
  return ["off", "destructive", "all"].includes(v) ? v : CONFIRM_SCOPE_DEFAULT;
}

/** Does THIS request need a confirmation? Called from the write path
 * BEFORE any mutation. Returns null (no) or the op tag ("delete" |
 * "overwrite" | "bulk") for the ask.
 *
 * Semantics (Dandan 2026-09-07: "deletes + overwrites"):
 *   - a write to a path that does NOT exist yet = creation, not
 *     destructive → never asks (same as Claude Code new-file writes)
 *   - a write to an EXISTING path = overwrite → asks under scope "all"
 *   - bulk ops (/write_many, /zip) ask once per request under "all"
 *     when any target exists; /unzip asks once (members unknowable
 *     up front); /pdf_op /ocr_pdf /restores ask when the target exists
 */
async function confirmRequiredFor(method, path, body) {
  const scope = await confirmScope();
  if (scope === "off" || method !== "POST") return null;
  let b = {};
  try { b = typeof body === "string" ? JSON.parse(body || "{}") : (body || {}); } catch (e) {}

  if (path === "/delete") return "delete";
  if (scope !== "all") return null; // "destructive" = deletes only

  if (path === "/write" || path === "/write_b64" || path === "/edit") {
    return (await confirmTargetExists(b.path || "")) ? "overwrite" : null;
  }
  if (path === "/write_many") {
    const ws = Array.isArray(b.writes) ? b.writes : [];
    for (const w of ws) {
      if (w && w.path && (await confirmTargetExists(w.path))) return "bulk";
    }
    return null;
  }
  if (path === "/zip") {
    return (await confirmTargetExists(b.out || "")) ? "bulk" : null;
  }
  if (path === "/unzip") return "bulk"; // can overwrite unknowable members
  if (path === "/write_b64_chunk") {
    // finalize (last:true) overwrites the target; earlier chunks only
    // stage parts in .ofb-chunks/ — gate ONLY the finalizing call.
    // The body passed here carries {path, last} (fs-writes normalize).
    return body && body.__finalizing && (await confirmTargetExists(body.path || ""))
      ? "overwrite" : null;
  }
  if (path === "/pdf_op" || path === "/ocr_pdf" ||
      path === "/versions/restore" || path === "/trash/restore") {
    return (await confirmTargetExists(b.out || b.path || "")) ? "overwrite" : null;
  }
  return null; // /write_b64_chunk internals reach here only via finalize;
               // the initiating /write_b64 carried the gate decision
}

/** Overwrite detection for scopes that need it (future: "new-file"
 * scope) — exists check without mutation. */
async function confirmTargetExists(relPath) {
  try {
    const rg = await resolveGuarded(unquoteComp(String(relPath || "")), {});
    return !!(await getFileFor(rg.rootRec, rg.parts));
  } catch (e) {
    return false; // unresolvable = not an overwrite (the write path will
  }                // produce its own honest error)
}

/** Gate entry: returns null (proceed) or the 403 response body. */
async function confirmGate(method, path, body, senderTabId) {
  const op = await confirmRequiredFor(method, path, body);
  if (op === null) return null;

  // a live grant for this exact op+path? (single-use on success)
  const now = Date.now();
  for (const [gid, g] of CONFIRM_PENDING) {
    if (g.op === op && g.pathKey === pathKeyFor(path, body) &&
        g.verdict === "approved" && now - g.ts < CONFIRM_GRANT_TTL_MS) {
      CONFIRM_PENDING.delete(gid); // single-use
      return null; // proceed
    }
    if (now - g.ts > CONFIRM_GRANT_TTL_MS) CONFIRM_PENDING.delete(gid); // expire
  }
  // denied earlier and still fresh → keep refusing (no re-ask spam)
  for (const [gid, g] of CONFIRM_PENDING) {
    if (g.op === op && g.pathKey === pathKeyFor(path, body) &&
        g.verdict === "denied" && now - g.ts < 60 * 1000) {
      return confirmBody(gid, g, "denied");
    }
  }

  // raise the ask (new id; a stale identical ask gets replaced)
  const id = "c" + hexRand(8);
  const entry = {
    op: op,
    pathKey: pathKeyFor(path, body),
    summary: describeOp(op, path, body),
    tabId: senderTabId,
    ts: now,
    verdict: null,
  };
  CONFIRM_PENDING.set(id, entry);
  pushConfirmPopup(id, entry); // fire-and-forget; popup is the UX, not the gate
  return confirmBody(id, entry, null);
}

function pathKeyFor(path, body) {
  // the retry must match the SAME op; body path is the file identity
  try {
    const b = typeof body === "string" ? JSON.parse(body || "{}") : (body || {});
    return path + "|" + String(b.path || b.out || "");
  } catch (e) {
    return path + "|";
  }
}

function describeOp(op, path, body) {
  try {
    const b = typeof body === "string" ? JSON.parse(body || "{}") : (body || {});
    if (op === "delete") return "delete " + (b.path || "?");
    if (op === "bulk") {
      if (path === "/zip") return "create archive " + (b.out || "?") +
        " from " + (Array.isArray(b.members) ? b.members.length : "?") + " files";
      if (path === "/unzip") return "extract " + (b.path || "?") +
        " into " + (b.dest || "the shared folder");
      if (path === "/write_many") {
        const n = Array.isArray(b.writes) ? b.writes.length : "?";
        return "write " + n + " files";
      }
      return path;
    }
    return "overwrite " + (b.path || "?");
  } catch (e) {
    return op + " " + path;
  }
}

function confirmBody(id, entry, verdict) {
  const b = {
    error: verdict === "denied"
      ? "the user DENIED this operation"
      : "confirmation required — the user is being asked in the Open WebUI page",
    confirmation_required: true,
    confirm_id: id,
    op: entry.op,
    detail: entry.summary,
    hint: verdict === "denied"
      ? "do not retry; ask the user in chat what they want instead"
      : "tell the user a confirmation popup appeared; after they click " +
        "Approve, retry this exact request once (single-use approval, " +
        "5-minute validity). If denied, do not retry.",
  };
  if (verdict === "denied") b.denied = true;
  return b;
}

/** Content-script popup push. The SW cannot reach into a page directly:
 * confirm.js in the OWUI tab polls? NO — it listens. We send a runtime
 * message; only the tab matching senderTabId renders it (tab-scoped via
 * chrome.tabs.sendMessage). */
function pushConfirmPopup(id, entry) {
  try {
    if (entry.tabId != null && chrome.tabs && chrome.tabs.sendMessage) {
      chrome.tabs.sendMessage(entry.tabId, {
        ofbConfirm: true, id: id, op: entry.op, summary: entry.summary,
      });
    }
  } catch (e) { /* popup is UX, not correctness */ }
}

/** Verdict from the content script (Approve/Deny click). */
function confirmVerdict(id, verdict) {
  const e = CONFIRM_PENDING.get(id);
  if (!e) return { ok: false, error: "unknown or expired confirmation" };
  if (e.verdict !== null) return { ok: false, error: "already answered" };
  e.verdict = verdict === "approved" ? "approved" : "denied";
  e.ts = Date.now(); // grant window starts at the CLICK
  return { ok: true, verdict: e.verdict, summary: e.summary };
}

/** Pending list for the settings page (audit/debug). */
async function confirmStateReport() {
  const now = Date.now();
  const out = [];
  for (const [id, e] of CONFIRM_PENDING) {
    if (now - e.ts > CONFIRM_GRANT_TTL_MS) { CONFIRM_PENDING.delete(id); continue; }
    out.push({ id, op: e.op, detail: e.summary, verdict: e.verdict,
               age_ms: now - e.ts });
  }
  return out;
}
