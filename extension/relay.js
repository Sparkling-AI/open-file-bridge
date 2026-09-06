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

  function pruneMinute() {
    const cutoff = Date.now() - 60000;
    while (minuteStamps.length && minuteStamps[0] < cutoff) minuteStamps.shift();
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
      pruneMinute();
      if (minuteStamps.length >= MAX_PER_MINUTE) {
        try { ev.source.postMessage({ ofb: true, id: m.id, ok: false, status: 0,
          error: "rate limit" }, "*"); } catch (e) {}
        return;
      }
      if (inflight.size >= MAX_INFLIGHT) {
        try { ev.source.postMessage({ ofb: true, id: m.id, ok: false, status: 0,
          error: "too many in-flight" }, "*"); } catch (e) {}
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
      chrome.runtime.sendMessage(
        { ofb: true, id, method: m.method, path: m.path, body: m.body,
          b64: m.b64 === true },
        (resp) => {
          const slot = inflight.get(id);
          inflight.delete(id);
          if (!slot) return; // unknown/timeout id — drop
          const out = resp || { ofb: true, id, ok: false, status: 0,
                                error: "extension context unavailable" };
          out.ofb = true; out.id = id;
          try { slot.source.postMessage(out, "*"); } catch (e) {}
        }
      );
    }
  }, false);
})();
