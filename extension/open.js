// Open File Bridge — outcome-link page (Stage 3 degrade family).
//
// Hosts the /link nonces: shows the file path + a copy button (an
// extension cannot open the OS file manager — honest degrade, plan §2).
// CSRF shape-gate: this page is only ever reached by a TOP-LEVEL user
// navigation (the assistant prints open.html?n=… links); it performs no
// privileged action beyond displaying a path, so the app's
// Sec-Fetch-Dest/Mode gate is enforced where the URL is minted and
// consumed — here we additionally refuse to run inside a frame.

"use strict";

(async () => {
  if (window !== window.top) {
    document.getElementById("title").textContent = "🛑 Opened in a frame";
    document.getElementById("note").textContent =
      "Open File Bridge links only work as normal links, opened by the user.";
    return;
  }
  const n = new URLSearchParams(location.search).get("n") || "";
  if (!/^[0-9a-f]{8,64}$/.test(n)) {
    document.getElementById("title").textContent = "🤷 Link not recognized";
    document.getElementById("note").textContent =
      "This is not a valid Open File Bridge link. Ask in chat for a fresh one.";
    return;
  }
  const rec = await OFBIDB.get("clicks", n);
  if (!rec || rec.expiry < Date.now()) {
    if (rec) await OFBIDB.del("clicks", n);
    document.getElementById("title").textContent = "⏳ Link expired";
    document.getElementById("note").textContent =
      "Outcome links live 7 days by default. Ask in chat and the assistant can issue a fresh one.";
    return;
  }
  const root = (await OFBIDB.get("roots", rec.rootId || "main")) ||
    ((await OFBIDB.all("roots")) || [])[0];
  const folder = root ? (root.alias || root.handle && root.handle.name || root.id) : "?";
  document.getElementById("title").textContent =
    rec.kind === "reveal" ? "📂 File location" : "📄 File ready";
  document.getElementById("note").className = "ok";
  document.getElementById("note").textContent =
    "Folder: " + folder + " — an extension cannot open the OS file manager; " +
    "the path below points at the file inside that folder.";
  document.getElementById("path").textContent = folder + "/" + rec.path;
  const btn = document.getElementById("copy");
  btn.hidden = false;
  btn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(document.getElementById("path").textContent);
      btn.textContent = "Copied ✓";
    } catch (e) {
      btn.textContent = "Copy failed — select the path manually";
    }
  };
})();
