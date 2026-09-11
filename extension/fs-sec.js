// Open File Bridge — sender security gate (Stage 3, 2026-09-11).
//
// Restores the desktop app's two-tier boundary (file_bridge.py
// check_request) to the extension pipe:
//   tier 1 — SITE LOCK: exactly ONE site (the user's Open WebUI origin)
//     may issue pipe requests. Dandan 2026-09-11: "make it only accept
//     one site — multiple sites behind one bridge token doesn't make
//     sense" — the bridge serves ONE deployment; the token is its second
//     lock, not a shared key for several. The site is taken from the
//     BROWSER-set sender metadata (sender.origin / sender.url), never
//     from message fields — page JS cannot forge them. Strict
//     scheme://host:port (match patterns cannot pin ports, so the SW is
//     the enforcement point; every localhost port is its own origin).
//   tier 2 — BRIDGE TOKEN (opt-in, app parity): an org-wide secret the
//     page must present per request. Closes the residual gap tier 1
//     cannot: same-origin impostors — any local process can bind
//     127.0.0.1:<port> when the real service is down and serve a fake
//     page at the EXACT allowed origin; a plain-http LAN deployment can
//     be injected into. The impostor page does not know the token.
//     Like the app, the token is an ORG boundary, not a user secret: the
//     user pastes it into chat once when asked; the model must never
//     echo it. (It cannot defend code injection into the REAL page —
//     injected code sees everything the page holds.)
//   UNLOCKED (no site, no token) is DENIED outright — same hard-fail
//     as the app's production mode. Default-deny on fresh installs and
//     upgrades; the settings page offers blocked origins as one-click
//     "Use this site" rows so recovery is one visit.
//
// Trusted senders: the extension's OWN pages (options, engine host,
// guide, open) are exempt — their sender URL is chrome-extension://.

"use strict";

const SEC_TOKEN_MAX_LEN = 256;
const SEC_DENIED_KEEP = 8;

/* ---------------- kv helpers (fs-idb is loaded first) ---------------- */

/** The ONE allowed site origin, or null. Migrates the 3.0.18-era
 *  `allowed_origins` LIST (first entry wins) so upgrades keep working. */
async function secAllowedSite() {
  try {
    const one = await kvGet("allowed_site", null);
    if (typeof one === "string" && one) return one;
    const legacy = await kvGet("allowed_origins", []);
    if (Array.isArray(legacy) && legacy.length &&
        typeof legacy[0] === "string" && legacy[0]) {
      return legacy[0];
    }
  } catch (e) { /* fall through */ }
  return null;
}

/** Store the one site; clears the legacy list key so reads stay clean. */
async function secSetAllowedSite(origin) {
  await kvSet("allowed_site", origin || null);
  try { await OFBIDB.del("kv", "allowed_origins"); } catch (e) {}
}

async function secBridgeToken() {
  const v = await kvGet("bridge_token", null);
  return typeof v === "string" && v ? v : null;
}

/** 'site+token' | 'token' | 'site' | 'UNLOCKED'. */
async function secMode() {
  const hasTok = (await secBridgeToken()) !== null;
  const hasSite = (await secAllowedSite()) !== null;
  if (hasTok && hasSite) return "site+token";
  if (hasTok) return "token";
  if (hasSite) return "site";
  return "UNLOCKED";
}

/* ---------------- sender identity (browser-controlled) ---------------- */

/** Own EXTENSION PAGES (options, engine host, guide, open) are trusted.
 *  CAREFUL: content scripts ALSO carry sender.id === chrome.runtime.id
 *  (they are the extension, from the browser's viewpoint) — the reliable
 *  discriminator is the sender URL's scheme. Content-script senders have
 *  http(s) URLs and are gated; extension pages have chrome-extension://
 *  URLs and pass. Returns {trusted, origin} — origin null when trusted
 *  or when the sender cannot be placed (denied by secGate). */
function secSender(sender) {
  try {
    if (sender && typeof sender.url === "string" &&
        sender.url.startsWith("chrome-extension://")) {
      return { trusted: true, origin: null };
    }
  } catch (e) { /* fall through */ }
  let origin = null;
  try {
    if (sender && typeof sender.origin === "string" && sender.origin) {
      origin = sender.origin;
    } else if (sender && typeof sender.url === "string" && sender.url) {
      origin = new URL(sender.url).origin;
    }
  } catch (e) { origin = null; }
  return { trusted: false, origin: origin };
}

/* ---------------- token compare (hash-then-compare) -------------------- */

async function _sha256Hex(s) {
  const buf = await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode(String(s)));
  let out = "";
  for (const b of new Uint8Array(buf)) out += b.toString(16).padStart(2, "0");
  return out;
}

/** True when no token tier is configured, or the supplied token matches.
 *  Comparing SHA-256 digests keeps the comparison length-uniform. */
async function secTokenOk(supplied, actual) {
  if (!actual) return true;
  if (typeof supplied !== "string" || !supplied ||
      supplied.length > SEC_TOKEN_MAX_LEN) return false;
  return (await _sha256Hex(supplied)) === (await _sha256Hex(actual));
}

/* ---------------- denied-origin ring (settings suggestions) ------------- */

async function secNoteDenied(origin) {
  try {
    const rows = (await kvGet("denied_origins", [])) || [];
    const kept = rows.filter((r) => r && r.o !== origin).slice(0, SEC_DENIED_KEEP - 1);
    kept.unshift({ o: origin, ts: Date.now() });
    await kvSet("denied_origins", kept);
  } catch (e) { /* suggestions are UX, never correctness */ }
}

/* ---------------- the gate ------------------------------------------------ */

/** Returns null (proceed) or the full pipe-shaped 403 response. Mirrors
 *  the app's check_request ordering: identity first, then token. */
async function secGate(msg, sender) {
  const id = msg.id;
  const who = secSender(sender);
  if (who.trusted) return null;

  if (!who.origin) {
    return { ofb: true, id: id, ok: false, status: 403, body: JSON.stringify({
      error: "untrusted sender — this request did not come from an allowed page",
      security_blocked: true,
      hint: "tell the user: the Open File Bridge extension refused an " +
            "unidentifiable sender; if this keeps happening, reload the page",
    }) };
  }

  const site = await secAllowedSite();
  if (!site && (await secBridgeToken()) === null) {
    return { ofb: true, id: id, ok: false, status: 403, body: JSON.stringify({
      error: "bridge locked — no site is allowed yet",
      security_locked: true,
      origin: who.origin,
      hint: "tell the user: click the Open File Bridge toolbar icon → " +
            "🔒 Security → Allowed site → set it to " + who.origin +
            " (one click if it appears under Recently blocked), then retry",
    }) };
  }

  if (site && who.origin !== site) {
    secNoteDenied(who.origin); // fire-and-forget
    return { ofb: true, id: id, ok: false, status: 403, body: JSON.stringify({
      error: "origin " + who.origin + " is not the allowed site",
      origin_blocked: true,
      origin: who.origin,
      hint: "tell the user: click the Open File Bridge toolbar icon → " +
            "🔒 Security → Allowed site → set it to " + who.origin +
            " (one click under Recently blocked; this REPLACES the current " +
            "site), then retry",
    }) };
  }

  const tok = await secBridgeToken();
  if (tok && !(await secTokenOk(msg.token, tok))) {
    return { ofb: true, id: id, ok: false, status: 403, body: JSON.stringify({
      error: "missing or invalid bridge token",
      token_required: true,
      origin: who.origin,
      hint: "ask the user ONCE for the bridge token (Open File Bridge " +
            "toolbar icon → 🔒 Security → Bridge token, Show/copy), add it " +
            "as the token field on every request, retry after setting it. " +
            "NEVER echo the token back in your answer. If the token you " +
            "send is already the right one, the page may hold a STALE " +
            "relay from before the last extension update (it drops the " +
            "token silently) — tell the user to REFRESH the page once, " +
            "then retry",
    }) };
  }

  return null;
}
