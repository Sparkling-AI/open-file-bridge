// Open File Bridge — outcome links (Stage 3 degrade family).
//
// An extension cannot open the OS file manager. /link mints nonce URLs
// hosted by the EXTENSION PAGE (open.html?n=…) that show the file path
// + a copy button. /click keeps its CSRF shape-gate in that page.
// (No tabs permission — open.html uses window.opener/self location.)
//
// 3.2.0: URLs are ABSOLUTE (chrome.runtime.getURL) and open.html is
// web_accessible_resources — the OWUI chat renderer keeps
// chrome-extension:// hrefs (verified live 2026-09-12), so a printed
// [name](open_url) is a real clickable link. Write responses embed the
// pair (app _attach_links port: models echo response fields faithfully
// but skip optional extra calls — guarantees belong in the bridge).

"use strict";

async function mintOutcomeLinks(relInRoot) {
  const ttl = await kvGet("link_ttl", 604800);
  const tokOpen = hexRand(16);
  const tokReveal = hexRand(16);
  const exp = Date.now() + ttl * 1000;
  await OFBIDB.put("clicks", { token: tokOpen, kind: "open", path: relInRoot, expiry: exp, sibling: tokReveal });
  await OFBIDB.put("clicks", { token: tokReveal, kind: "reveal", path: relInRoot, expiry: exp, sibling: tokOpen });
  return {
    open_url: chrome.runtime.getURL("open.html?n=" + tokOpen),
    reveal_url: chrome.runtime.getURL("open.html?n=" + tokReveal),
    ttl: ttl,
    say: "in your ANSWER, beside the file name: " +
      "[📄 Open](open_url) · [📂 Show in folder](reveal_url) — the " +
      "extension page shows the path with a copy button (an extension " +
      "cannot open the OS file manager)",
  };
}

async function epLink(body) {
  const raw = unquoteComp(String(body.path || ""));
  // accept the "/rel" written-path echo or a plain rel
  const rel = raw.startsWith("/") ? raw.slice(1) : raw;
  if (!rel) {
    return fsFail(400, { error: "path is outside every shared root (or is a root itself)" });
  }
  const rg = await resolveGuarded(rel);
  // file must exist (app: mint AFTER the file exists)
  await getFileFor(rg.rootRec, rg.parts);
  const links = await mintOutcomeLinks(rg.relInRoot);
  await auditRow({ endpoint: "/link", method: "POST", path: rg.relInRoot, status: 200 });
  return fsOk(Object.assign({
    path: rg.relInRoot, manager: "extension page",
    usage: "write responses already carry links — this re-mints an expired pair. " +
      "Put both in your answer beside the name: 📄 Open + 📂 Show in folder",
  }, links));
}

/* Attach outcome links to a successful write response (app _json rule:
   200 + POST + the response names the produced/edited/restored file).
   Best-effort — never fails a write. Skips when the file no longer
   resolves (e.g. transient states) or links are already present
   (write_many's inner /write calls come through the wrapped router). */
async function attachWriteLinks(resp) {
  if (!resp || resp.status !== 200 || typeof resp.body !== "string") return;
  let obj;
  try { obj = JSON.parse(resp.body); } catch (e) { return; }
  if (!obj || typeof obj !== "object" || obj.links) return;
  const rel0 = obj.written || (obj.edited && obj.path) || obj.restored;
  const rel = typeof rel0 === "string" ? (rel0.startsWith("/") ? rel0.slice(1) : rel0) : null;
  if (!rel) return;
  try {
    const rg = await resolveGuarded(rel);
    await getFileFor(rg.rootRec, rg.parts); // exists check — gone ⇒ no link
    obj.links = await mintOutcomeLinks(rg.relInRoot);
    resp.body = JSON.stringify(obj);
  } catch (e) { /* outside root / resolution failed — leave response as-is */ }
}
