// Open File Bridge — outcome-link page (Stage 3 degrade family).
//
// Hosts the /link nonces: shows the file path + a copy button (an
// extension cannot open the OS file manager — honest degrade, plan §2),
// plus "Save a copy to Downloads" (blob <a download> — no extra
// permission; the browser's own download flow). When the user filled in
// the folder's full path (settings → Folder → Location — the File
// System Access API never reveals it, only the folder's name), the
// shown/copied path is ABSOLUTE and opens anywhere (Finder Go→Folder,
// terminals, apps).
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
  // absolute prefix when the user declared it (browser APIs never
  // reveal the granted folder's real path — only its name)
  const base = root && root.os_path ? root.os_path : folder;
  document.getElementById("title").textContent =
    rec.kind === "reveal" ? "📂 File location" : "📄 File ready";
  const note = document.getElementById("note");
  note.className = "ok";
  note.textContent =
    "Folder: " + folder + " — " + (root && root.os_path
      ? "the path below is the full path on this computer; paste it anywhere (Finder Go→Folder, an app's open dialog) or save a copy."
      : "an extension cannot open the OS file manager; the path below is inside that folder. For a full openable path, set the folder's Location in the extension settings, or save a copy.");
  document.getElementById("path").textContent = base + "/" + rec.path;
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

  /* Save a copy: walk the granted handle to the file, then let the
   * browser download the blob (a COPY — the shared original is never
   * touched). The click is the user gesture, so a permission re-ask
   * (browser restart) can also be satisfied here. */
  const saveBtn = document.getElementById("save");
  saveBtn.hidden = false;
  saveBtn.onclick = async () => {
    saveBtn.textContent = "Saving…";
    try {
      if (!root || !root.handle) throw new Error("folder not connected");
      const mode = root.mode === "read" ? "read" : "readwrite";
      let ps = await root.handle.queryPermission({ mode: mode });
      if (ps !== "granted") ps = await root.handle.requestPermission({ mode: mode });
      if (ps !== "granted") throw Object.assign(new Error("permission not granted"), { name: "NotAllowedError" });
      let dir = root.handle;
      const parts = rec.path.split("/");
      const fname = parts.pop();
      for (const p of parts) dir = await dir.getDirectoryHandle(p);
      const file = await (await dir.getFileHandle(fname)).getFile();
      const url = URL.createObjectURL(file);
      const a = document.createElement("a");
      a.href = url;
      a.download = fname; // lands in the browser's Downloads folder
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      saveBtn.textContent = "Saved to Downloads ✓";
    } catch (e) {
      saveBtn.textContent = e && e.name === "NotAllowedError"
        ? "Permission lost — click Open File Bridge → Reconnect, then retry"
        : "Save failed — " + String(e && e.message || e).slice(0, 70);
    }
  };
})();
