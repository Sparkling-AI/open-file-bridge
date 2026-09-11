// Open File Bridge — engine host page (Stage 3).
//
// tesseract.js + pdfium-WASM + pdf-lib instantiate HERE (a live extension
// page), not in the SW (plan §4.2). The SW forwards engine endpoint requests
// to this page over chrome.runtime messaging; the page holds engine
// instances and answers asynchronously. This page ALSO holds the folder
// permission session-grant alive while it's open (probe-verified model).
//
// The page never touches the file system: inputs arrive as File objects
// the SW resolved, outputs go back as bytes the SW writes.

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
    (e) => sendResponse({
      ok: false,
      error: String((e && e.statusCode || "") && (e.statusCode + "|" + ((e && e.message) || e)) || ((e && e.message) || e)),
    })
  );
  return true;
});

function fsEngineHello() {
  chrome.runtime.sendMessage({ ofbEngineHello: true }, () => {
    void chrome.runtime.lastError; // SW may be asleep; it wakes on next use
  });
}

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
  log("engine host page up");
  // The FIRST hello goes out only AFTER engine-impl.js registers its
  // handlers: the hello flips the SW's FS_ENGINE_ALIVE, and registration
  // takes seconds (vendor/wasm loads) — a hello before that made the
  // first engine call answer 500 "engine not loaded" (real chat
  // 2026-09-09). Not-alive remains the safe resting state; the SW's
  // auto-start loop waits for this post-registration hello.
  keepalivePing();
  setInterval(keepalivePing, 5000);
  import(chrome.runtime.getURL("engine-impl.js"))
    .then(() => {
      log("engines registered: pdfium + tesseract.js + pdf-lib");
      fsEngineHello();
      setInterval(fsEngineHello, 30000);
    })
    .catch((e) => log("engine load FAILED: " + e));
});
