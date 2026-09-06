// Open File Bridge — engine host page logic (Stage 3).
//
// tesseract.js + pdfium-WASM instantiate HERE (a visible extension
// page), not in the SW (plan §4.2): WASM re-instantiation per SW cold
// start would be slow and burn the 5-min cap. The SW forwards engine
// endpoint requests to this page over chrome.runtime messaging; the
// page holds engine instances and answers asynchronously.
//
// Engines land in P3 (pdfium) and P4 (tesseract.js); handlers register
// into ENGINE_HANDLERS when their vendor scripts load.

"use strict";

const ENGINE_HANDLERS = {};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.ofbEngine !== true) return;
  const h = ENGINE_HANDLERS[msg.op];
  if (!h) {
    sendResponse({ ok: false, error: "engine not loaded: " + msg.op });
    return;
  }
  h(msg.payload).then(
    (r) => sendResponse({ ok: true, result: r }),
    (e) => sendResponse({ ok: false, error: String((e && e.message) || e) })
  );
  return true;
});

function log(msg) {
  const el = document.getElementById("log");
  if (el) el.textContent += msg + "\n";
}

async function keepalivePing() {
  try {
    const roots = await OFBIDB.all("roots");
    const el = document.getElementById("roots");
    if (el) el.textContent = roots.length
      ? roots.map((r) => (r.alias || r.id) + " (" + (r.mode || "readwrite") + ")").join(", ")
      : "none";
  } catch (e) {}
}

window.addEventListener("DOMContentLoaded", () => {
  log("engine host page up (engines land in P3/P4)");
  keepalivePing();
  setInterval(keepalivePing, 5000);
});
