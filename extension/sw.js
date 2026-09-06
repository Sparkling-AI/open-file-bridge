// Open File Bridge — service worker (Stage 3).
//
// SECURITY INVARIANT (STAGE3-PLAN §5): this worker is a NARROW PIPE,
// never a general fetch proxy. With the loopback backend gone there is
// NO network egress from the extension at all — a message chooses a
// path within the user-granted folder, never a destination host.
//  - Only messages of shape {ofb:true, id, method, path, body?} are
//    accepted; the router runs against FileSystemHandles (fs-adapter).
//  - The tier-2 token is RETIRED (plan §5.2): the boundary is the
//    browser's per-op permission gate + the relay's gates.
//  - Payload caps and concurrency caps mirror the page relay.

importScripts("fs-idb.js", "fs-core.js", "fs-adapter.js", "fs-writes.js",
  "fs-links.js", "fs-engine.js");

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB request payload cap
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024; // 64 MB response cap
const MAX_INFLIGHT = 30;

let inflight = 0;

function swFail(id, error, status = 0) {
  return { ofb: true, id, ok: false, status, error: String(error) };
}

async function handleOfbRequest(msg) {
  const id = msg.id;
  const method = String(msg.method || "GET").toUpperCase();
  const path = String(msg.path || "");

  // ---- shape gate: narrow pipe only ----
  if (!/^\/[A-Za-z0-9_\-./?&=%+]*$/.test(path)) {
    return swFail(id, "bad path", 0);
  }
  if (!["GET", "POST", "DELETE"].includes(method)) {
    return swFail(id, "bad method", 0);
  }
  if (path.includes("..")) {
    return swFail(id, "bad path", 0);
  }
  let bodyText = null;
  if (msg.body !== undefined && msg.body !== null) {
    if (typeof msg.body !== "string") return swFail(id, "body must be a string", 0);
    if (msg.body.length > MAX_BODY_BYTES) return swFail(id, "body too large", 0);
    bodyText = msg.body;
  }
  const wantB64 = msg.b64 === true;
  if (inflight >= MAX_INFLIGHT) {
    return swFail(id, "too many in-flight requests", 0);
  }

  inflight++;
  try {
    const resp = await fsRoute(method, path, bodyText);
    if (wantB64 && resp.bodyB64 !== undefined) {
      if (resp.bodyB64.length > MAX_RESPONSE_BYTES) {
        return swFail(id, "response too large", resp.status);
      }
      return { ofb: true, id, ok: resp.status === 200, status: resp.status, bodyB64: resp.bodyB64 };
    }
    if (wantB64) {
      // caller asked for bytes but endpoint is textual — return the JSON
      return { ofb: true, id, ok: resp.status === 200, status: resp.status, body: resp.body };
    }
    let body = resp.body || "";
    if (body.length > MAX_RESPONSE_BYTES) {
      return { ofb: true, id, ok: false, status: resp.status,
        error: "response too large", truncated: true, body: body.slice(0, MAX_RESPONSE_BYTES) };
    }
    return { ofb: true, id, ok: resp.status === 200, status: resp.status, body };
  } catch (e) {
    return swFail(id, "adapter error", 0);
  } finally {
    inflight--;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;
  // narrow pipe: only the exact OFB request shape
  if (msg.ofb !== true || msg.id === undefined) return; // not ours: ignore
  handleOfbRequest(msg).then(sendResponse);
  return true; // async sendResponse
});
