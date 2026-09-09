// Open File Bridge — out-of-band confirmation gate (Stage 3).
//
// Dandan's ask: destructive ops (delete + overwrite by default) must get
// an OUT-OF-CHAT confirmation — a popup rendered by the extension INSIDE
// the Open WebUI page (the thing the desktop app can never do), like
// Claude Code / Codex permission prompts.
//
// DESIGN v2 (2026-09-09, after the approve-retry LOOP bug):
//   v1 never waited for the click (403 ask → popup → model retry) and
//   kept verdicts ONLY in SW memory — MV3 SWs die after ~30 s idle, so
//   an Approve click after a worker restart armed NOTHING while the
//   card still said "Approved" → every retry raised a fresh ask → loop.
//   v2, per Dandan's spec:
//     1. gated op → popup pushed to the requesting tab; the request
//        BLOCKS on the verdict for CONFIRM_WAIT_MS (20 s — under the
//        relay's 120 s id TTL, the skill's 60 s cell timeout, OWUI's
//        60 s executor limit, and the SW's 30 s idle window, leaving
//        ~40 s for the actual write).
//     2. Approve within the window → the SAME call executes the op and
//        returns the real result (one round trip). Deny → 403 denied.
//     3. No click in time → 403 {confirmation_required, timed_out} and
//        the ask STAYS armed (persisted): a late Approve is consumed by
//        the next identical retry (single-use, 5-min grant TTL).
//   All asks/verdicts are persisted in IndexedDB ("confirm" store,
//   fs-idb v2) so SW death can never eat an approval again.
//
// Scope (configurable in the settings UI, kv "confirm_scope"):
//   "off"            — no confirmations (v2.11 behavior)
//   "destructive"    — deletes only
//   "all"            — deletes + every overwrite (default)

"use strict";

const CONFIRM_TTL_MS = 5 * 60 * 1000; // pending asks auto-expire
const CONFIRM_GRANT_TTL_MS = 5 * 60 * 1000; // approved grant lifetime
const CONFIRM_SCOPE_DEFAULT = "all"; // "off" | "destructive" | "all"
const CONFIRM_WAIT_MS = 20 * 1000; // blocking wait for the user's click
const CONFIRM_POLL_MS = 200; // verdict poll while blocking

// pending: id → {op, pathKey, tabId, ts, verdict: null|"approved"|"denied"}
let CONFIRM_PENDING = new Map();

/* ---------------- persistence (survives SW death) ---------------- */

async function dbPutConfirm(entry) {
  try { await OFBIDB.put("confirm", JSON.parse(JSON.stringify(
    Object.assign({}, entry, { source: undefined })))); } catch (e) {}
}

async function dbDelConfirm(id) {
  try { await OFBIDB.del("confirm", id); } catch (e) {}
}

async function dbGetConfirm(id) {
  try { return await OFBIDB.get("confirm", id); } catch (e) { return null; }
}

async function dbAllConfirm() {
  try { return (await OFBIDB.all("confirm")) || []; } catch (e) { return []; }
}

/** Find a consumable approved grant in memory, else in the DB. Single-use:
 *  the winner is deleted from BOTH stores before returning. */
async function findLiveGrant(op, pathKey) {
  const now = Date.now();
  for (const [gid, g] of CONFIRM_PENDING) {
    if (now - g.ts > CONFIRM_GRANT_TTL_MS) { CONFIRM_PENDING.delete(gid); continue; }
    if (g.op === op && g.pathKey === pathKey && g.verdict === "approved") {
      CONFIRM_PENDING.delete(gid);
      dbDelConfirm(gid);
      return g;
    }
  }
  for (const row of await dbAllConfirm()) {
    if (!row || !row.ts) continue;
    if (now - row.ts > CONFIRM_GRANT_TTL_MS) { dbDelConfirm(row.id); continue; }
    if (row.op === op && row.pathKey === pathKey && row.verdict === "approved") {
      dbDelConfirm(row.id);
      CONFIRM_PENDING.delete(row.id);
      return row;
    }
  }
  return null;
}

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
  if (path === "/versions/restore" || path === "/trash/restore") {
    // restores: `path` IS the write target
    return (await confirmTargetExists(b.path || "")) ? "overwrite" : null;
  }
  if (path === "/pdf_op" || path === "/ocr_pdf") {
    // engine WRITE ops: the only write target is `out` — `path` is the
    // INPUT. Regression 2026-09-09: the old `b.out || b.path` fallback
    // asked to "overwrite" the INPUT image on an /ocr_pdf with no out
    // (Dandan denied the popup; even approved it would have 400'd
    // "missing out" — a pure false alarm). Missing out is engineCall's
    // own honest 400, never a confirmation.
    return (await confirmTargetExists(b.out || "")) ? "overwrite" : null;
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

/** Gate entry: returns null (proceed — including after an in-window
 *  approval) or the 403 response body. BLOCKS up to CONFIRM_WAIT_MS. */
async function confirmGate(method, path, body, senderTabId) {
  const op = await confirmRequiredFor(method, path, body);
  if (op === null) return null;

  // a live grant for this exact op+path? (late Approve, retry path)
  if (await findLiveGrant(op, pathKeyFor(path, body))) return null; // proceed

  // denied earlier and still fresh → keep refusing (no re-ask spam)
  const now = Date.now();
  for (const [gid, g] of CONFIRM_PENDING) {
    if (g.op === op && g.pathKey === pathKeyFor(path, body) &&
        g.verdict === "denied" && now - g.ts < 60 * 1000) {
      return confirmBody(gid, g, "denied");
    }
  }

  // raise the ask (new id; a stale identical ask gets replaced)
  const id = "c" + hexRand(8);
  const entry = {
    id: id,
    op: op,
    pathKey: pathKeyFor(path, body),
    summary: describeOp(op, path, body),
    tabId: senderTabId,
    ts: now,
    verdict: null,
  };
  CONFIRM_PENDING.set(id, entry);
  await dbPutConfirm(entry);
  pushConfirmPopup(id, entry); // fire-and-forget; popup is the UX, not the gate

  // BLOCK for the user's click (the 2026-09-09 behavior change): the
  // freshly-woken SW's ~30 s idle window comfortably covers the wait,
  // and each click message resets it anyway.
  const t0 = Date.now();
  while (Date.now() - t0 < CONFIRM_WAIT_MS) {
    await new Promise((r) => setTimeout(r, CONFIRM_POLL_MS));
    const e = CONFIRM_PENDING.get(id);
    if (e && e.verdict === "approved") {
      CONFIRM_PENDING.delete(id);
      await dbDelConfirm(id);
      return null; // proceed — SAME call returns the real result
    }
    if (e && e.verdict === "denied") {
      const out = confirmBody(id, e, "denied");
      CONFIRM_PENDING.delete(id);
      await dbDelConfirm(id);
      return out;
    }
    // a previous SW instance may hold the click (SW died and relaunched
    // between ask and click) — check the persisted copy too
    if ((Date.now() - t0) % 1000 < CONFIRM_POLL_MS) {
      const row = await dbGetConfirm(id);
      if (row && row.verdict === "approved") {
        await dbDelConfirm(id);
        return null; // proceed
      }
      if (row && row.verdict === "denied") {
        const out = confirmBody(id, row, "denied");
        await dbDelConfirm(id);
        return out;
      }
    }
  }

  // timed out: keep the ask armed — a late Approve still grants the
  // next identical retry (findLiveGrant above)
  const out = confirmBody(id, entry, null);
  out.timed_out = true;
  out.hint = "no approval within " + Math.round(CONFIRM_WAIT_MS / 1000) +
    " s — tell the user to click Approve on the popup (or to say when " +
    "they have), then retry this exact request ONCE. A late click still " +
    "counts; denied means do not retry.";
  return out;
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
      : "confirmation required — waiting for the user to click Approve timed out",
    confirmation_required: true,
    confirm_id: id,
    op: entry.op,
    detail: entry.summary,
    hint: verdict === "denied"
      ? "do not retry; ask the user in chat what they want instead"
      : "a popup with Approve/Deny appeared in the Open WebUI page. If the " +
        "user already clicked Approve, retry this exact request once " +
        "(single-use, 5-minute validity). If denied, do not retry.",
  };
  if (verdict === "denied") b.denied = true;
  return b;
}

/** Content-script popup push. The SW cannot reach into a page directly:
 * confirm.js in the OWUI tab listens. We send a runtime message; only
 * the tab matching senderTabId renders it (tab-scoped via
 * chrome.tabs.sendMessage). */
function pushConfirmPopup(id, entry) {
  try {
    if (entry.tabId != null && chrome.tabs && chrome.tabs.sendMessage) {
      chrome.tabs.sendMessage(entry.tabId, {
        ofbConfirm: true, id: id, op: entry.op, summary: entry.summary,
        wait_ms: CONFIRM_WAIT_MS,
      });
    }
  } catch (e) { /* popup is UX, not correctness */ }
}

/** Verdict from the content script (Approve/Deny click). Recovers the
 *  entry from IndexedDB when this SW instance never saw the ask. */
async function confirmVerdict(id, verdict) {
  let e = CONFIRM_PENDING.get(id);
  if (!e) {
    e = await dbGetConfirm(id);
    if (e) CONFIRM_PENDING.set(id, e);
  }
  if (!e) return { ok: false, error: "unknown or expired confirmation" };
  if (e.verdict !== null) return { ok: false, error: "already answered" };
  e.verdict = verdict === "approved" ? "approved" : "denied";
  e.ts = Date.now(); // grant window starts at the CLICK
  await dbPutConfirm(e);
  return { ok: true, verdict: e.verdict, summary: e.summary };
}

/** Pending list for the settings page (audit/debug). */
async function confirmStateReport() {
  const now = Date.now();
  const out = [];
  for (const [id, e] of CONFIRM_PENDING) {
    if (now - e.ts > CONFIRM_GRANT_TTL_MS) { CONFIRM_PENDING.delete(id); continue; }
    out.push({ id: id, op: e.op, detail: e.summary, verdict: e.verdict,
               age_ms: now - e.ts });
  }
  for (const row of await dbAllConfirm()) {
    if (out.some((o) => o.id === row.id)) continue;
    if (row && row.ts && now - row.ts <= CONFIRM_GRANT_TTL_MS) {
      out.push({ id: row.id, op: row.op, detail: row.summary,
                 verdict: row.verdict, age_ms: now - row.ts });
    }
  }
  return out;
}
