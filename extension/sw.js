// Open File Bridge Connector — service worker.
//
// SECURITY INVARIANT (EXTENSION-PLAN.md §3): this worker is a NARROW PIPE,
// never a general fetch proxy.
//  - Only messages of shape {ofb:true, id, method, path, body?} are accepted.
//  - The bridge origin (scheme+host+port) is HARDCODED — a message can never
//    choose the destination. No other host, scheme, or port is ever fetched.
//  - The tier-2 token lives in chrome.storage.local and is attached here by
//    the SW; page/model code never sees it.
//  - Payload caps and concurrency caps mirror the page relay so neither side
//    can be turned into a hammer.

const BRIDGE_ORIGIN = "http://127.0.0.1:8765"; // HARDCODED — do not make configurable
const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB request payload cap
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024; // 64 MB response cap
const MAX_INFLIGHT = 30;

let inflight = 0;

function fail(id, error, status = 0) {
  return { ofb: true, id, ok: false, status, error: String(error) };
}

async function handleBridgeRequest(msg) {
  const id = msg.id;
  const method = String(msg.method || "GET").toUpperCase();
  const path = String(msg.path || "");

  // ---- shape gate: narrow pipe only ----
  if (!/^\/[A-Za-z0-9_\-./?&=%+]*$/.test(path)) {
    return fail(id, "bad path", 0);
  }
  if (!["GET", "POST", "DELETE"].includes(method)) {
    return fail(id, "bad method", 0);
  }
  if (path.includes("..")) {
    return fail(id, "bad path", 0);
  }
  let bodyText = null;
  if (msg.body !== undefined && msg.body !== null) {
    if (typeof msg.body !== "string") return fail(id, "body must be a string", 0);
    if (msg.body.length > MAX_BODY_BYTES) return fail(id, "body too large", 0);
    bodyText = msg.body;
  }
  // binary responses (wheels, /read_b64, /image_b64): caller opts in with
  // b64:true -> response returned as bodyB64 (base64). Boolean only.
  const wantB64 = msg.b64 === true;
  if (inflight >= MAX_INFLIGHT) {
    return fail(id, "too many in-flight requests", 0);
  }

  // ---- token: attached here, never exposed to the page ----
  let token = null;
  try {
    const st = await chrome.storage.local.get(["bridgeToken"]);
    token = st.bridgeToken || "";
  } catch (e) {
    /* storage unavailable — proceed without token; bridge will 401 */
  }

  const headers = { "Content-Type": "application/json" };
  if (token) headers["X-Bridge-Token"] = token;

  inflight++;
  try {
    const resp = await fetch(BRIDGE_ORIGIN + path, {
      method,
      headers,
      body: method === "GET" || method === "DELETE" ? undefined : bodyText,
    });
    if (wantB64) {
      const buf = await resp.arrayBuffer();
      if (buf.byteLength > MAX_RESPONSE_BYTES) {
        return fail(id, "response too large", resp.status);
      }
      // base64 in the SW (no btoa on binary strings in SW scope quirks)
      let bin = "";
      const bytes = new Uint8Array(buf);
      const CH = 32768;
      for (let i = 0; i < bytes.length; i += CH) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
      }
      return { ofb: true, id, ok: resp.ok, status: resp.status,
               bodyB64: btoa(bin) };
    }
    let text = await resp.text();
    if (text.length > MAX_RESPONSE_BYTES) {
      text = text.slice(0, MAX_RESPONSE_BYTES);
      return { ofb: true, id, ok: false, status: resp.status,
               error: "response too large", truncated: true, body: text };
    }
    return { ofb: true, id, ok: resp.ok, status: resp.status, body: text };
  } catch (e) {
    // fetch refused: bridge not running, network error, or blocked host —
    // never leak the destination control to the caller.
    return fail(id, "bridge unreachable", 0);
  } finally {
    inflight--;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;
  // narrow pipe: only the exact OFB request shape
  if (msg.ofb !== true || msg.id === undefined) return; // not ours: ignore
  handleBridgeRequest(msg).then(sendResponse);
  return true; // async sendResponse
});
