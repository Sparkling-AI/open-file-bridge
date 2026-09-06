// Open File Bridge — folder grant page (Stage 3, plan §4).
//
// showDirectoryPicker() requires a user gesture in a VISIBLE page (it is
// not exposed in service-worker scope), so this page is the only place
// handles are minted. Handles are FileSystemHandle objects: structured-
// cloneable → persisted in IndexedDB (chrome.storage cannot hold them).

"use strict";

// The script loads from <head> — all DOM wiring happens on
// DOMContentLoaded (module-level getElementById returns null before it).

async function state() {
  const roots = (await OFBIDB.all("roots")) || [];
  const el = document.getElementById("roots");
  el.innerHTML = "";
  for (const r of roots) {
    const row = document.createElement("div");
    row.className = "root-row";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = (r.alias || r.id) + " — " + (r.handle && r.handle.name) +
      " (" + (r.mode || "readwrite") + (r.writesEnabled === false ? ", writes off" : "") + ")";
    const perm = document.createElement("button");
    perm.className = "secondary";
    perm.textContent = "Reconnect";
    perm.onclick = async () => {
      const ps = await r.handle.queryPermission({ mode: r.mode === "read" ? "read" : "readwrite" });
      if (ps === "granted") { status("Permission already granted", "ok"); return; }
      try {
        const res = await r.handle.requestPermission({ mode: r.mode === "read" ? "read" : "readwrite" });
        status(res === "granted" ? "Reconnected — permission granted" : "Permission not granted", res === "granted" ? "ok" : "err");
      } catch (e) { status("Reconnect failed: " + e, "err"); }
      state();
    };
    const toggle = document.createElement("button");
    toggle.className = "secondary";
    toggle.textContent = r.writesEnabled === false ? "Enable writes" : "Disable writes";
    toggle.onclick = async () => {
      r.writesEnabled = r.writesEnabled === false ? true : false;
      await OFBIDB.put("roots", r);
      state();
    };
    const del = document.createElement("button");
    del.className = "secondary";
    del.textContent = "Remove";
    del.onclick = async () => {
      await OFBIDB.del("roots", r.id);
      state();
    };
    row.append(name, perm, toggle, del);
    el.appendChild(row);
  }
}

function status(text, cls) {
  let s = document.getElementById("status");
  if (!s) {
    s = document.createElement("p");
    s.id = "status";
    document.getElementById("intro").after(s);
  }
  s.textContent = text;
  s.className = cls || "";
}

let rootSeq = 1;

window.addEventListener("DOMContentLoaded", async () => {
  rootSeq = ((await OFBIDB.all("roots")) || []).length + 1;
  state();
  document.getElementById("pick").onclick = async () => {
    try {
      const handle = await window.showDirectoryPicker({ mode: "readwrite" });
      // permission is granted by the pick itself for this session
      let id = "main";
      const existing = (await OFBIDB.all("roots")) || [];
      if (existing.length) {
        id = "r" + (rootSeq + existing.length);
      }
      const ps = await handle.queryPermission({ mode: "readwrite" });
      await OFBIDB.put("roots", {
        id: id,
        alias: handle.name,
        mode: "readwrite",
        handle: handle,
        grantedAt: Date.now(),
        writesEnabled: true,
        ignore: [],
      });
      status("Folder connected: " + handle.name + (ps === "granted" ? "" : " (permission: " + ps + ")"), "ok");
      state();
    } catch (e) {
      if (String(e && e.name) === "AbortError") { status("Folder selection cancelled.", ""); return; }
      status("Could not open the folder picker: " + e, "err");
    }
  };
});
