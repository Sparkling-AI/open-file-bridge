// Open File Bridge — settings page (Stage 3, unified).
//
// ONE page for both entry points: the toolbar icon and chrome://extensions
// → Options both land here (sw.js opens options.html; setup.html redirects
// to it). Sections mirror the desktop app's settings page (src/file_bridge.py
// PICKER_HTML) with extension semantics: no origin/token card input (the
// browser permission gate replaced them), folder grants instead of a root
// path, engines hosted in a tab instead of in-process.
//
// Reads (health/state/tree) go through the service-worker pipe — the SAME
// router the OWUI relay uses, so the page shows exactly what the model gets
// (engine aliveness lives in the SW, not in this page). Writes to settings
// go straight to the shared IndexedDB (kv store), which the SW also reads.

"use strict";

/* ---------------- pipe to the service worker (relay.js shape) ------------- */

let _pipeSeq = 1;

function pipe(method, path, bodyObj) {
  return new Promise((resolve) => {
    const id = "opt" + (_pipeSeq++);
    const msg = { ofb: true, id, method, path };
    if (bodyObj !== undefined) msg.body = JSON.stringify(bodyObj);
    chrome.runtime.sendMessage(msg, (resp) => {
      if (!resp || resp.ofb !== true) {
        resolve({ ok: false, status: 0, error: "extension context unavailable" });
        return;
      }
      let data = {};
      try { data = JSON.parse(resp.body || "{}"); } catch (e) {}
      resolve({
        ok: resp.ok, status: resp.status,
        error: data.error || (resp.ok ? null : "http " + resp.status), data,
      });
    });
  });
}

/* ---------------- shared bits (ported from the app page) ------------------ */

const LANG_NAMES = {
  eng: "English", swe: "Swedish", chi_sim: "Chinese (Simplified)",
  dan: "Danish", nor: "Norwegian", deu: "German", fra: "French",
  spa: "Spanish",
};

function esc(s) {
  return String(s).replace(/[&<>"']/g, (m) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}
function fmtSize(n) {
  if (n == null) return "";
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
  return (n / 1048576).toFixed(1) + " MB";
}
function fmtTTL(v) {
  return v >= 31536000 ? "1 year"
    : (v >= 2592000 ? (v / 2592000) + " month" + (v >= 5184000 ? "s" : "")
    : (v >= 86400 ? (v / 86400) + " day" + (v >= 172800 ? "s" : "")
    : (v / 3600) + " hour" + (v >= 7200 ? "s" : "")));
}

// (fold-state restore lives in the DOMContentLoaded handler below — this
// script loads from <head>, so details.sec does not exist yet at parse time)

/* ---------------- heartbeat (/health every 5 s) ---------------------------- */

let lastHealth = null; // {ok, roots:[{id,path,perm}], addons, ocr_lang, ...}
let langSig = "";      // last rendered language-box signature (avail|current)
let langDirty = false; // user has unsaved ticks/input — beat must not clobber

async function beat() {
  const dot = document.getElementById("beat");
  const info = document.getElementById("beatinfo");
  const r = await pipe("GET", "/health");
  if (!r.ok) {
    dot.style.color = "#b00";
    info.textContent = "no response from the extension worker — try reloading this page";
    return;
  }
  lastHealth = r.data;
  dot.style.color = "#0a7d32";
  const roots = r.data.roots || [];
  const needPerm = roots.filter((x) => x.perm !== "granted");
  info.textContent = "Running · v" + (r.data.version || "?") +
    " · security: extension" +
    (roots.length
      ? (needPerm.length
        ? " · ⚠ " + needPerm.length + " folder" + (needPerm.length > 1 ? "s" : "") + " need Reconnect"
        : " · " + roots.map((x) => x.path).join(", "))
      : " · no folder chosen yet");
  // engines card state (lives in the SW, not this page — hence the pipe).
  // addons = bundled capability; engine_alive = the engine tab's heartbeat.
  const eng = r.data.addons || { pdf: false, ocr: false };
  const alive = !!r.data.engine_alive;
  document.getElementById("engstat").innerHTML =
    "PDF &amp; OCR engines " + (eng.pdf && eng.ocr ? "bundled" : "missing??") + " · " +
    (alive ? '<span class="ok">engine tab running</span>'
      : '<span class="warn">engine tab not running</span> — PDF text extraction, ' +
        "PDF operations and OCR will ask for it; open it below and keep it open.");
  // language boxes depend on engine aliveness (available list comes empty
  // otherwise). Skip while the user has unsaved ticks — the 5 s beat must
  // not clobber a half-edited selection.
  const sig = (r.data.ocr_langs_available || []).join(",") + "|" + (r.data.ocr_lang || "");
  if (!langDirty && sig !== langSig) {
    langSig = sig;
    renderLangs(r.data.ocr_langs_available || [], r.data.ocr_lang || "eng");
  }
}

/* ---------------- settings (/state once + after saves) --------------------- */

async function refresh() {
  try {
    const s = (await pipe("GET", "/state")).data;
    const ig = document.getElementById("ignorepats");
    if (ig !== null && document.activeElement !== ig)
      ig.value = (s.ignore_global || []).join("\n");
    const sel = document.getElementById("linkttl");
    let hit = [...sel.options].some((o) => +o.value === s.link_ttl);
    sel.value = hit ? String(s.link_ttl)
      : (s.link_ttl >= 31536000 ? "31536000" : "604800");
    document.getElementById("ttlinfo").textContent =
      "Links live " + fmtTTL(+sel.value) + " (custom values round to the nearest choice here).";
    const rl = s.rate_limits || {};
    document.getElementById("ratelimitw").value = rl.max_writes != null ? rl.max_writes : 20;
    document.getElementById("ratelimitmb").value = rl.max_mb != null ? rl.max_mb : 50;
    document.getElementById("ratestat").textContent =
      "Current: " + rl.max_writes + " writes / " + rl.max_mb + " MiB per 60 s.";
    document.getElementById("readonlybox").checked = !!s.readonly;
    renderRoots();
    renderAudit();
    renderPreview();
  } catch (e) {
    document.getElementById("secstatus").textContent =
      "✗ could not load settings (" + (e.message || e) + ")";
  }
}

/* ---------------- OCR language card (ported from the app page) -------------- */

function renderLangs(avail, cur) {
  const box = document.getElementById("langbox");
  const sel = new Set(String(cur || "").split("+").filter(Boolean));
  const order = [...(avail || [])].sort((a, b) =>
    (LANG_NAMES[a] || a).localeCompare(LANG_NAMES[b] || b));
  box.innerHTML = order.length ? order.map((c) =>
    "<label><input type=\"checkbox\" value=\"" + esc(c) + "\"" +
    (sel.has(c) ? " checked" : "") + "> " + esc(c) +
    (LANG_NAMES[c] ? " — " + LANG_NAMES[c] : "") + "</label>").join(" ")
    : '<span class="hint">no bundled languages available in this build</span>';
  const inp = document.getElementById("ocrlang");
  if (inp !== null && document.activeElement !== inp) inp.value = cur || "eng";
}

function syncBoxes(fromBoxes) {
  const inp = document.getElementById("ocrlang");
  if (fromBoxes) {
    const v = [...document.querySelectorAll("#langbox input:checked")].map((x) => x.value);
    inp.value = v.join("+");
  } else {
    const sel = new Set(inp.value.split(/[+,\s]+/).filter(Boolean));
    document.querySelectorAll("#langbox input").forEach((x) => { x.checked = sel.has(x.value); });
  }
}

/* ---------------- shared folders card (ported from setup.js) ---------------- */

function status(text, cls) {
  const s = document.getElementById("folderstatus");
  s.textContent = text;
  s.className = cls || "";
}

async function renderRoots() {
  const roots = (await OFBIDB.all("roots")) || [];
  const el = document.getElementById("roots");
  el.innerHTML = "";
  for (const r of roots) {
    const row = document.createElement("div");
    row.className = "root-row";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = (r.alias || r.id) + " (" + (r.mode || "readwrite") +
      (r.writesEnabled === false ? ", writes off" : "") + ")";
    const perm = document.createElement("button");
    perm.className = "small secondary";
    perm.textContent = "Reconnect";
    perm.onclick = async () => {
      const ps = await r.handle.queryPermission({ mode: r.mode === "read" ? "read" : "readwrite" });
      if (ps === "granted") { status("Permission already granted", "ok"); return; }
      try {
        const res = await r.handle.requestPermission({ mode: r.mode === "read" ? "read" : "readwrite" });
        status(res === "granted" ? "Reconnected — permission granted" : "Permission not granted",
          res === "granted" ? "ok" : "warn");
      } catch (e) { status("Reconnect failed: " + e, "warn"); }
      renderRoots(); beat();
    };
    const toggle = document.createElement("button");
    toggle.className = "small secondary";
    toggle.textContent = r.writesEnabled === false ? "Enable writes" : "Disable writes";
    toggle.onclick = async () => {
      r.writesEnabled = r.writesEnabled === false ? true : false;
      await OFBIDB.put("roots", r);
      renderRoots();
    };
    const del = document.createElement("button");
    del.className = "small secondary";
    del.textContent = "Remove";
    del.onclick = async () => {
      await OFBIDB.del("roots", r.id);
      renderRoots(); beat(); renderPreview();
    };
    row.append(name, perm, toggle, del);
    el.appendChild(row);
  }
}

let rootSeq = 1;

async function pickFolder() {
  try {
    const handle = await window.showDirectoryPicker({ mode: "readwrite" });
    let id = "main";
    const existing = (await OFBIDB.all("roots")) || [];
    if (existing.length) id = "r" + (rootSeq + existing.length);
    const ps = await handle.queryPermission({ mode: "readwrite" });
    await OFBIDB.put("roots", {
      id: id, alias: handle.name, mode: "readwrite", handle: handle,
      grantedAt: Date.now(), writesEnabled: true, ignore: [],
    });
    status("Folder connected: " + handle.name + (ps === "granted" ? "" : " (permission: " + ps + ")"), "ok");
    renderRoots(); beat(); renderPreview();
  } catch (e) {
    if (String(e && e.name) === "AbortError") { status("Folder selection cancelled.", ""); return; }
    status("Could not open the folder picker: " + e, "warn");
  }
}

/* ---------------- preview card (app renderPreview, extension tree) --------- */

async function renderPreview() {
  if (window._pvBusy) return;
  window._pvBusy = true;
  const box = document.getElementById("preview");
  const info = document.getElementById("previnfos");
  const t0 = performance.now();
  try {
    const roots = (lastHealth && lastHealth.roots) || [];
    if (!roots.length) {
      box.innerHTML = "🔒 no folder chosen yet";
      info.textContent = "";
      return;
    }
    if (roots[0].perm !== "granted") {
      box.innerHTML = "🔒 permission needed — press Reconnect in Shared folders above";
      info.textContent = "";
      return;
    }
    const r = await pipe("GET", "/directory_tree?path=.&max_entries=500&max_depth=6");
    if (!r.ok) {
      box.innerHTML = "🔒 " + esc(r.error || "preview unavailable");
      info.textContent = "";
      return;
    }
    const tree = r.data.tree || { children: [] };
    // remember which folders the user had open so auto-refresh doesn't collapse them
    const openPaths = new Set([...box.querySelectorAll("details[open]")].map((d) => d.dataset.p));
    let nf = 0, nd = 0;
    function row(node, depth, path) {
      const kids = node.children || [];
      if (node.type === "dir") {
        nd++;
        const p = path + "/" + node.name;
        const open = openPaths.has(p) || depth < 1;
        const html = kids.map((ch) => row(ch, depth + 1, p)).join("");
        return "<details data-p=\"" + esc(p) + "\"" + (open ? " open" : "") + ">" +
          "<summary style=\"cursor:pointer\">📁 " + esc(node.name) +
          " <span style=\"color:#999\">" + kids.length + "</span></summary>" +
          "<div style=\"margin-left:14px\">" + html + "</div></details>";
      }
      nf++;
      return "<div>📄 " + esc(node.name) +
        (node.size != null ? " <span style=\"color:#999\">" + fmtSize(node.size) + "</span>" : "") + "</div>";
    }
    const html = (tree.children || []).map((ch) => row(ch, 0, "")).join("");
    box.innerHTML = html || "(empty folder)";
    info.textContent = nf + " file" + (nf === 1 ? "" : "s") + " · " + nd + " folder" + (nd === 1 ? "" : "s") +
      (r.data.truncated ? " · TRUNCATED at cap — the model sees the same limit" : "") +
      " · ignore lists applied";
  } catch (e) {
    box.innerHTML = "preview unavailable: " + esc(e.message || e);
  } finally {
    window._pvBusy = false;
    window._pvMs = performance.now() - t0;
  }
}

/* ---------------- audit card (unchanged from the old options page) --------- */

async function renderAudit() {
  const el = document.getElementById("auditrows");
  try {
    const rows = await new Promise((resolve, reject) => {
      const dbReq = indexedDB.open("ofb-ext", 1);
      dbReq.onsuccess = () => {
        const db = dbReq.result;
        const tx = db.transaction("audit", "readonly");
        const open = tx.objectStore("audit").openCursor(null, "prev");
        const out = [];
        open.onsuccess = () => {
          const cur = open.result;
          if (cur && out.length < 12) { out.push(cur.value); cur.continue(); }
          else resolve(out);
        };
        open.onerror = () => reject(open.error);
      };
      dbReq.onerror = () => reject(dbReq.error);
    });
    el.textContent = rows.length
      ? rows.map((r) => new Date(r.ts).toLocaleTimeString() + "  " +
          (r.endpoint || r.op || "?") + "  " + (r.path || "") +
          (r.size !== undefined ? "  " + r.size + "B" : "") +
          "  → " + (r.status || (r.ok ? 200 : "?")))
        .join("\n")
      : "no activity yet";
  } catch (e) {
    el.textContent = "audit unavailable: " + e;
  }
}

/* ---------------- wiring ---------------------------------------------------- */

// The script loads from <head> — DOM wiring must happen on DOMContentLoaded
// (the setup.js hazard this file's history already documents). All button
// wiring is synchronous ahead of the first await so an eager test click on
// #pick can't race the IDB read.
window.addEventListener("DOMContentLoaded", async () => {
  // fold-state restore first (the app page runs this at end-of-body; here
  // the DOM only exists inside this handler) — same localStorage
  // key/layout the desktop app's page uses
  const FOLD_KEY = "ofb.folded";
  try {
    const saved = JSON.parse(localStorage.getItem(FOLD_KEY) || "{}");
    document.querySelectorAll("details.sec").forEach((d) => {
      if (d.id && d.id in saved) d.open = !saved[d.id];
      d.addEventListener("toggle", () => {
        const f = {};
        document.querySelectorAll("details.sec").forEach((x) => { if (x.id && !x.open) f[x.id] = 1; });
        try { localStorage.setItem(FOLD_KEY, JSON.stringify(f)); } catch (e) {}
      });
    });
  } catch (e) {}

  document.getElementById("pick").onclick = () => pickFolder();

  document.getElementById("savelang").onclick = async () => {
    syncBoxes(false);
    const l = document.getElementById("ocrlang").value.trim();
    const r = await pipe("POST", "/ocr/lang", { lang: l });
    langDirty = false; langSig = ""; // force re-render from the saved value
    document.getElementById("langs").textContent =
      r.ok ? "✓ OCR language: " + r.data.ocr_lang : "✗ " + (r.error || "failed");
    beat();
  };
  document.getElementById("langbox").addEventListener("change", () => { langDirty = true; syncBoxes(true); });
  document.getElementById("ocrlang").addEventListener("input", () => { langDirty = true; syncBoxes(false); });

  document.getElementById("saveignore").onclick = async () => {
    const pats = document.getElementById("ignorepats").value.split("\n")
      .map((s) => s.trim()).filter(Boolean);
    await OFBIDB.put("kv", pats, "ignore_global");
    document.getElementById("ignstat").textContent =
      "✓ saved — " + (pats.length ? pats.length + " pattern" + (pats.length > 1 ? "s" : "") : "ignoring nothing extra");
    renderPreview();
  };

  document.getElementById("savettl").onclick = async () => {
    const v = parseInt(document.getElementById("linkttl").value, 10);
    if (Number.isFinite(v)) await OFBIDB.put("kv", v, "link_ttl");
    document.getElementById("ttlinfo").textContent = "Links live " + fmtTTL(v) + " ✓";
  };

  document.getElementById("saverate").onclick = async () => {
    const w = parseInt(document.getElementById("ratelimitw").value, 10);
    const mb = parseInt(document.getElementById("ratelimitmb").value, 10);
    if (Number.isFinite(w) && w >= 1) await OFBIDB.put("kv", w, "rate_max_writes");
    if (Number.isFinite(mb) && mb >= 1) await OFBIDB.put("kv", mb, "rate_max_mb");
    document.getElementById("ratestat").textContent =
      "✓ Current: " + w + " writes / " + mb + " MiB per 60 s.";
  };

  document.getElementById("readonlybox").onchange = async (ev) => {
    await OFBIDB.put("kv", ev.target.checked, "readonly_global");
    document.getElementById("rostat").textContent = ev.target.checked ? "— active" : "";
  };

  document.getElementById("openguide").onclick = () => {
    chrome.tabs ? chrome.tabs.create({ url: "guide.html" }) : window.open("guide.html");
  };
  document.getElementById("engbtn").onclick = () => {
    chrome.tabs ? chrome.tabs.create({ url: "engine-host.html" }) : window.open("engine-host.html");
  };
  document.getElementById("pvrefresh").onclick = (ev) => {
    ev.preventDefault(); // inside <summary> — don't toggle the card
    renderPreview();
  };

  rootSeq = (((await OFBIDB.all("roots")) || []).length) + 1;
  refresh();
  beat();
  setInterval(beat, 5000);
  (function pvLoop() {
    setTimeout(async () => {
      if (document.visibilityState === "visible") await renderPreview();
      pvLoop();
    }, (window._pvMs || 0) > 1500 ? 30000 : 5000);
  })();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") { beat(); renderPreview(); renderAudit(); }
  });
});
