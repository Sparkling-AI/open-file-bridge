// Open File Bridge — settings page (Stage 3).
//
// Token UI is GONE (retired with the app, plan §5.2). Replacement
// consent controls: per-root write toggle (on setup.html) + the Safety
// card (rate limits, OCR language) + the audit view.

"use strict";

async function loadSettings() {
  const w = await OFBIDB.get("kv", "rate_max_writes");
  const mb = await OFBIDB.get("kv", "rate_max_mb");
  const lang = await OFBIDB.get("kv", "ocr_lang");
  document.getElementById("rate_writes").value = w === undefined ? 20 : w;
  document.getElementById("rate_mb").value = mb === undefined ? 50 : mb;
  document.getElementById("ocr_lang").value = lang === undefined ? "eng" : lang;
}

async function loadRoots() {
  const roots = (await OFBIDB.all("roots")) || [];
  const el = document.getElementById("roots");
  el.innerHTML = "";
  if (!roots.length) {
    el.innerHTML = '<p class="small err">No folder connected yet — click the button above.</p>';
    return;
  }
  for (const r of roots) {
    const row = document.createElement("div");
    row.className = "root-row";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = (r.alias || r.id) + " (" + (r.mode || "readwrite") +
      (r.writesEnabled === false ? ", writes off" : "") + ")";
    el.appendChild(row).appendChild(name);
  }
}

async function loadAudit() {
  // show the last 12 audit rows (newest last; autoincrement store)
  const el = document.getElementById("auditrows");
  try {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open("ofb-ext", 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const rows = await new Promise((resolve, reject) => {
      const tx = db.transaction("audit", "readonly");
      const os = tx.objectStore("audit");
      const open = os.openCursor(null, "prev");
      const out = [];
      open.onsuccess = () => {
        const cur = open.result;
        if (cur && out.length < 12) { out.push(cur.value); cur.continue(); }
        else resolve(out);
      };
      open.onerror = () => reject(open.error);
    });
    el.textContent = rows.length
      ? rows.map((r) => new Date(r.ts).toLocaleTimeString() + "  " +
          (r.endpoint || r.op || "?") + "  " + (r.path || "") +
          (r.size !== undefined ? "  " + r.size + "B" : "") +
          "  → " + (r.status || (r.ok ? 200 : "?")))
        .reverse().join("\n")
      : "no activity yet";
    el.style.whiteSpace = "pre";
  } catch (e) {
    el.textContent = "audit unavailable: " + e;
  }
}

// The script loads from <head> — same hazard setup.js documents: DOM
// wiring must happen on DOMContentLoaded (module-level getElementById
// returns null before it, which killed this script and left #setup dead).
window.addEventListener("DOMContentLoaded", () => {
  document.getElementById("save").onclick = async () => {
    const w = parseInt(document.getElementById("rate_writes").value, 10);
    const mb = parseInt(document.getElementById("rate_mb").value, 10);
    const lang = document.getElementById("ocr_lang").value.trim();
    if (Number.isFinite(w) && w >= 1) await OFBIDB.put("kv", w, "rate_max_writes");
    if (Number.isFinite(mb) && mb >= 1) await OFBIDB.put("kv", mb, "rate_max_mb");
    if (lang) await OFBIDB.put("kv", lang, "ocr_lang");
    const s = document.getElementById("saved");
    s.hidden = false;
    setTimeout(() => { s.hidden = true; }, 1500);
  };

  document.getElementById("setup").onclick = () => {
    chrome.tabs ? chrome.tabs.create({ url: "setup.html" }) : window.open("setup.html");
  };

  loadSettings();
  loadRoots();
  loadAudit();
});
