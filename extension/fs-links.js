// Open File Bridge — outcome links (Stage 3 degrade family).
//
// An extension cannot open the OS file manager. /link mints nonce URLs
// hosted by the EXTENSION PAGE (open.html?n=…) that show the file path
// + a copy button. /click keeps its CSRF shape-gate in that page.
// (No tabs permission — open.html uses window.opener/self location.)

"use strict";

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
  const ttl = await kvGet("link_ttl", 604800);
  const tokOpen = hexRand(16);
  const tokReveal = hexRand(16);
  const exp = Date.now() + ttl * 1000;
  await OFBIDB.put("clicks", { token: tokOpen, kind: "open", path: rg.relInRoot, expiry: exp, sibling: tokReveal });
  await OFBIDB.put("clicks", { token: tokReveal, kind: "reveal", path: rg.relInRoot, expiry: exp, sibling: tokOpen });
  await auditRow({ endpoint: "/link", method: "POST", path: rg.relInRoot, status: 200 });
  return fsOk({
    path: rg.relInRoot, ttl: ttl,
    open_url: "open.html?n=" + tokOpen,
    reveal_url: "open.html?n=" + tokReveal,
    manager: "extension page",
    usage: "outcome links open the extension page which shows the file path with a copy button (an extension cannot open the OS file manager). Keep plain code spans for passing mentions.",
  });
}
