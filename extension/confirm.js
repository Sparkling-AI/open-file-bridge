// Open File Bridge — in-page confirmation popup (content script, 2026-09-07).
//
// Renders the Approve/Deny card INSIDE the Open WebUI page when the
// bridge SW gates a destructive op (delete/overwrite). The card lives in
// a closed shadow root: host-page CSS cannot restyle it and its nodes
// don't leak into the page. relay.js is untouched — this is a sibling
// content script with ONE job: render asks, send verdicts.
//
// Security posture: the popup is UX, never authority. The SW's
// confirmGate is the gate; a hostile page could craft this script's
// messages, but the worst it can do is answer a pending ask that was
// raised FOR THAT PAGE'S OWN request (tab-scoped push, single-use,
// 5-min TTL). It cannot read files or widen the pipe.

"use strict";

(() => {
  if (window.__ofbConfirmHost) return; // idempotent (SPA re-injection)
  window.__ofbConfirmHost = true;

// NOTE (2026-09-08): do NOT use createElementNS here. The original
// version used NS "https://www.w3.org/1999/xhtml" — an https TYPO —
// which made the host a foreign (non-HTMLElement) element: dataset
// undefined (data-ofb-cards write threw silently) and the shadow
// <style> landed in the wrong namespace → never became a stylesheet →
// the CSS rendered as literal text. document.createElement always
// yields an HTML-namespace element in an HTML document.
  const host = document.createElement("div");
  host.id = "ofb-confirm-root";
  const root = host.attachShadow({ mode: "closed" });
  (document.body || document.documentElement).appendChild(host);

  root.innerHTML = `
  <style>
    .wrap { position: fixed; right: 20px; bottom: 20px; z-index: 2147483647;
            display: flex; flex-direction: column; gap: 10px;
            font-family: system-ui, -apple-system, sans-serif; }
    .card { width: 340px; background: #fff; color: #1a1a2e;
            border: 1px solid #c9cdd6; border-left: 4px solid #4a5fc1;
            border-radius: 10px; box-shadow: 0 8px 28px rgba(20,24,40,.22);
            padding: 14px 16px; animation: slidein .18s ease; }
    @keyframes slidein { from { opacity: 0; transform: translateY(8px); }
                         to   { opacity: 1; transform: none; } }
    .brand { display: flex; align-items: center; gap: 8px;
             font-weight: 600; font-size: 13px; color: #4a5fc1;
             margin-bottom: 8px; }
    .logo { width: 18px; height: 18px; border-radius: 4px; flex: none; }
    .op { font-size: 12px; text-transform: uppercase; letter-spacing: .06em;
          color: #666; margin-bottom: 2px; }
    .what { font-size: 14px; font-weight: 600; word-break: break-all;
            margin-bottom: 12px; }
    .what code { background: #f0f1f5; border: 1px solid #e2e4ea;
                 border-radius: 5px; padding: 1px 5px;
                 font-family: ui-monospace, monospace; font-size: 12.5px; }
    .row { display: flex; gap: 8px; }
    button { flex: 1; height: 36px; border-radius: 8px; font-size: 14px;
             cursor: pointer; border: 1px solid transparent; }
    .approve { background: #4a5fc1; color: #fff; }
    .approve:hover { filter: brightness(1.07); }
    .deny { background: #fff; color: #b00; border-color: #d66; }
    .deny:hover { background: #fdf2f2; }
    .meta { margin-top: 8px; font-size: 11.5px; color: #888;
            text-align: center; }
    .card.resolved .row { display: none; }
    .verdict { display: none; font-size: 13px; text-align: center;
               padding: 4px 0 2px; font-weight: 600; }
    .card.resolved .verdict { display: block; }
    .card.ok .verdict { color: #0a7d32; }
    .card.no .verdict { color: #b00; }
  </style>
  <div class="wrap"></div>`;

  const wrap = root.querySelector(".wrap");

  function makeCard(ask) {
    const card = document.createElement("div");
    card.className = "card";
    const whatHtml = String(ask.summary || "")
      .replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));
    card.innerHTML =
      '<div class="brand"><img class="logo" alt="" src="' +
        chrome.runtime.getURL("icons/icon-48.png") + '">' +
      'Open File Bridge</div>' +
      '<div class="op">' + (ask.op === "delete" ? "Delete file" :
        ask.op === "bulk" ? "Bulk operation" : "Overwrite file") +
      ' — approval needed</div>' +
      '<div class="what"><code>' + whatHtml.replace(/^(delete|overwrite|create archive|extract|write \d+ files) /, "$1</code> <code>") + "</code></div>" +
      '<div class="row">' +
      '<button class="approve">Approve</button>' +
      '<button class="deny">Deny</button></div>' +
      '<div class="verdict"></div>' +
      '<div class="meta">single-use · valid 5 min · from your AI assistant\u2019s request</div>';

    const settle = (verdict) => {
      card.classList.add("resolved", verdict === "approved" ? "ok" : "no");
      card.querySelector(".verdict").textContent =
        verdict === "approved" ? "✓ Approved — the assistant will retry" :
                                 "✗ Denied — nothing was changed";
      try {
        chrome.runtime.sendMessage({
          ofbConfirmVerdict: true, id: ask.id, verdict: verdict,
        }, () => { void chrome.runtime.lastError; });
      } catch (e) { /* SW gone: the ask expires server-side anyway */ }
      setTimeout(() => {
        try { card.remove(); } catch (e2) {}
        syncCount();
      }, 4000);
    };
    card.querySelector(".approve").addEventListener("click", () => settle("approved"));
    card.querySelector(".deny").addEventListener("click", () => settle("denied"));
    return card;
  }

  // main-world-visible counter (the shadow root is CLOSED so the page
  // can never reach the buttons — this attribute is test/debug
  // observable). Synced on every add AND remove.
  function syncCount() {
    try { host.setAttribute("data-ofb-cards", String(wrap.children.length)); } catch (e) {}
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.ofbConfirm !== true || !msg.id) return;
    // one card per ask; replace a stale duplicate if any
    const ask = { id: String(msg.id), op: msg.op, summary: msg.summary };
    const card = makeCard(ask);
    wrap.appendChild(card);
    while (wrap.children.length > 3) wrap.firstChild.remove(); // cap stack
    syncCount();
  });
})();
