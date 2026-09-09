// Open File Bridge Connector — page relay (content script).
//
// SECURITY INVARIANT (EXTENSION-PLAN.md §3.3): the OWUI Pyodide sandbox is an
// opaque-origin iframe that CAN postMessage to this page. Assume HOSTILE
// senders. This relay:
//  - accepts ONLY messages of shape {ofb:true, id, method, path, body?} and
//    ONLY from this window's own iframes (event.source must be an iframe
//    whose parent chain reaches window) — never from other windows/tabs;
//  - correlates requests to responses by id and drops ids that were never
//    issued (no unsolicited inbound);
//  - rate-limits: <=30 in-flight, <=120 requests/min, payload cap 10 MB;
//  - forwards responses ONLY to the exact iframe window that asked
//    (targeted postMessage), never a broadcast.
//
// WORKER TRANSPORT (2026-09-09): OWUI >= 0.11 can execute python cells in a
// pyodide WORKER (shared-worker executor) — no parent window exists there,
// so the iframe transport above is impossible and cells hung to their 60s
// timeout (DEVNOTES stage-3 session #7). Workers reach same-origin listeners
// via BroadcastChannel only, so this relay ALSO listens on channel
// "ofb-pipe". Exposure note: that channel is same-origin, i.e. this page's
// own scripts — which can already ride the window pipe (isDescendantIframe
// matches the page's own window, and a hostile page can proxy through its
// own iframes), so no new capability is granted. Each worker elects exactly
// ONE relay (the smallest tag that answers its hello wins) so N open OWUI
// tabs never forward the same request — a write must not execute twice.

(() => {
  if (window.__ofbRelayInstalled) return;
  window.__ofbRelayInstalled = true;

  const MAX_INFLIGHT = 30;
  const MAX_PER_MINUTE = 120;
  const MAX_PAYLOAD = 10 * 1024 * 1024; // 10 MB
  const MAX_AGE_MS = 120000; // forget ids after 2 min

  const inflight = new Map(); // id -> {source, t}
  const minuteStamps = [];
  let nextId = 1;

  // worker-pipe identity for the per-worker election; its in-flight count
  // shares the minute + total caps with the window pipe
  const RELAY_TAG = "r" + Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  let bcInflight = 0;

  function pruneMinute() {
    const cutoff = Date.now() - 60000;
    while (minuteStamps.length && minuteStamps[0] < cutoff) minuteStamps.shift();
  }

  function capReject() {
    pruneMinute();
    if (minuteStamps.length >= MAX_PER_MINUTE) return "rate limit";
    if (inflight.size + bcInflight >= MAX_INFLIGHT) return "too many in-flight";
    return null;
  }

  function isDescendantIframe(win) {
    // walk this window's frame tree; the sender must be one of OUR iframes
    try {
      let found = false;
      const walk = (w) => {
        if (w === win) { found = true; return; }
        for (let i = 0; i < w.length; i++) walk(w[i]);
      };
      walk(window);
      return found;
    } catch (e) {
      return false; // cross-origin frame tree access failure — reject
    }
  }

  window.addEventListener("message", (ev) => {
    const m = ev.data;
    if (!m || typeof m !== "object") return;
    if (m.ofb !== true) return;               // not the OFB pipe
    if (m.id !== undefined || m.method !== undefined) {
      // request-shaped: only from our own iframes
      if (!isDescendantIframe(ev.source)) return;
      if (typeof m.method !== "string" || typeof m.path !== "string") return;
      const cap = capReject();
      if (cap) {
        try { ev.source.postMessage({ ofb: true, id: m.id, ok: false, status: 0,
          error: cap }, "*"); } catch (e) {}
        return;
      }
      if (m.body !== undefined && m.body !== null) {
        if (typeof m.body !== "string") return;
        if (m.body.length > MAX_PAYLOAD) {
          try { ev.source.postMessage({ ofb: true, id: m.id, ok: false, status: 0,
            error: "payload too large" }, "*"); } catch (e) {}
          return;
        }
      }
      // clean stale ids
      const now = Date.now();
      for (const [k, v] of inflight) if (now - v.t > MAX_AGE_MS) inflight.delete(k);
      const id = m.id !== undefined ? m.id : nextId++;
      inflight.set(id, { source: ev.source, t: now });
      minuteStamps.push(now);
      try {
        chrome.runtime.sendMessage(
          { ofb: true, id, method: m.method, path: m.path, body: m.body,
            b64: m.b64 === true },
          (resp) => {
            inflight.delete(id);
            const out = resp || { ofb: true, id, ok: false, status: 0,
                                  error: "extension context unavailable" };
            out.ofb = true; out.id = id;
            try { ev.source.postMessage(out, "*"); } catch (e) {}
          }
        );
      } catch (e) {
        // orphaned content script (extension reloaded, page not refreshed):
        // fail fast instead of letting the caller hang to its full timeout
        inflight.delete(id);
        try { ev.source.postMessage({ ofb: true, id, ok: false, status: 0,
          error: "extension context invalidated — reload this page" }, "*"); } catch (e2) {}
      }
    }
  }, false);

  // ---- worker pipe (BroadcastChannel "ofb-pipe") ----
  try {
    const bc = new BroadcastChannel("ofb-pipe");
    bc.onmessage = (ev) => {
      const m = ev.data;
      if (!m || typeof m !== "object") return;
      if (m.ofbHello === true && typeof m.workerId === "string") {
        // election: every relay answers; the worker keeps the smallest tag
        try { bc.postMessage({ ofbRelay: true, workerId: m.workerId,
                               tag: RELAY_TAG }); } catch (e) {}
        return;
      }
      if (m.ofb !== true || m.id === undefined || m.method === undefined) return;
      if (m.to !== RELAY_TAG) return; // only the elected relay forwards
      if (typeof m.method !== "string" || typeof m.path !== "string") return;
      if (m.body !== undefined && m.body !== null &&
          (typeof m.body !== "string" || m.body.length > MAX_PAYLOAD)) return;
      const cap = capReject();
      if (cap) {
        try { bc.postMessage({ ofb: true, id: m.id, ok: false, status: 0,
          error: cap }); } catch (e) {}
        return;
      }
      minuteStamps.push(Date.now());
      bcInflight++;
      try {
        chrome.runtime.sendMessage(
          { ofb: true, id: m.id, method: m.method, path: m.path,
            body: m.body, b64: m.b64 === true },
          (resp) => {
            bcInflight--;
            const out = resp || { ofb: true, id: m.id, ok: false, status: 0,
                                  error: "extension context unavailable" };
            out.ofb = true; out.id = m.id;
            try { bc.postMessage(out); } catch (e) {}
          }
        );
      } catch (e) {
        bcInflight--;
        try { bc.postMessage({ ofb: true, id: m.id, ok: false, status: 0,
          error: "extension context invalidated — reload this page" }); } catch (e2) {}
      }
    };
  } catch (e) { /* BroadcastChannel unavailable — iframe transport still works */ }
})();
