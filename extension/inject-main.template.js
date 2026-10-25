// Open File Bridge — runtime-registered sandbox injector (spike, 2026-10-23).
//
// Registered DYNAMICALLY by the service worker (chrome.scripting.
// registerContentScripts) for the ONE origin the user set as their
// allowed site — never statically in the manifest, so the extension
// declares no broad https match at install time. Same guard + exports
// as the pilot org's tested design (b):
//   https://…/OFB_CLIENT_INJECTION_FINDINGS.md
//   - runs ONLY in a sandboxed srcdoc frame: not top, about:srcdoc,
//     self.origin === "null"
//   - defines frozen ofb.fetch + OFB_CLIENT_PY before any page script
//   - capture-phase message listener swallows relay replies that carry
//     THIS frame's id prefix, so stock Open WebUI's sandbox host never
//     sees them as code (stdout wipe fix)
//   - no chrome.*, no secrets
(function () {
  "use strict";
  if (window !== window.top) {
    if (location.href !== "about:srcdoc" || self.origin !== "null") return;
  } else {
    return;
  }
  if (typeof globalThis.ofb !== "undefined") return; // already injected

  var VER = "3.7.3-inj";
  var PREFIX = "ofbj-" + Math.random().toString(16).slice(2, 14);

  var pending = new Map();   // id -> resolve
  var n = 0;

  // reply interception — capture phase, BEFORE the sandbox host's own
  // listener (registered later): replies to OUR ids never reach it
  addEventListener("message", function (ev) {
    if (ev.source !== window.parent) return;
    var d = ev.data;
    if (!d || d.ofb !== true || typeof d.id !== "string") return;
    if (d.id.indexOf(PREFIX) !== 0) return;   // legacy bootstrap ids pass through
    ev.stopImmediatePropagation();
    var res = pending.get(d.id);
    if (res) {
      pending.delete(d.id);
      res({
        ok: d.ok === true, status: d.status,
        body: d.body || null, bodyB64: d.bodyB64 || null,
        error: d.error || null, truncated: d.truncated === true,
      });
    }
  }, true); // capture

  function fetch_(method, path, body, b64, token, timeoutMs) {
    var id = PREFIX + "-" + (n++);
    var ms = Math.min(600000, Math.max(1000, Number(timeoutMs) || 45000));
    return new Promise(function (resolve) {
      var done = false;
      pending.set(id, function (v) {
        if (done) return; done = true; pending.delete(id); resolve(v);
      });
      var msg = { ofb: true, id: id, method: String(method), path: String(path) };
      if (body !== null && body !== undefined && body !== "") msg.body = String(body);
      if (b64 === true) msg.b64 = true;
      if (token) msg.token = String(token);
      parent.postMessage(msg, "*");
      setTimeout(function () {
        if (done) return; done = true; pending.delete(id);
        resolve({ ok: false, status: 0, timeout: true,
          error: String(path) + ": no reply in " + Math.round(ms / 1000) +
            " s — the extension tab may need a reload" });
      }, ms);
    });
  }

  function define(name, value) {
    try {
      Object.defineProperty(globalThis, name, {
        value: value, writable: false, configurable: false,
      });
    } catch (e) { /* best effort */ }
  }

  define("__ofbInjected", VER);
  define("ofb", Object.freeze({
    version: VER,
    fetch: function (method, path, body, b64, token, timeoutMs) {
      return fetch_(method, path, body, b64, token, timeoutMs);
    },
  }));
  // OFB_CLIENT_PY is appended at BUILD time by scripts/build_inject.py
  // (embeds ofb-client.py as a JSON string literal).
  define("OFB_CLIENT_PY", "__OFB_CLIENT_PY_PLACEHOLDER__");
})();
