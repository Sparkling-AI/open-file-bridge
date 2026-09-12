// Open File Bridge — settings page (Stage 3, unified).
//
// ONE page for both entry points: the toolbar icon and chrome://extensions
// → Options both land here (sw.js opens options.html; setup.html redirects
// to it). Sections mirror the desktop app's settings page (src/file_bridge.py
// PICKER_HTML) with extension semantics: the origin allowlist + optional
// bridge token ARE the app's two security tiers (fs-sec.js, 2026-09-11),
// folder grants instead of a root path, engines hosted in a tab instead of
// in-process.
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

const LANG_NAMES = {  // names match the app page; render order is name-sorted
  ara: "Arabic", chi_sim: "Chinese (Simplified)",
  chi_tra: "Chinese (Traditional)", dan: "Danish", deu: "German",
  eng: "English", est: "Estonian", fin: "Finnish", fra: "French",
  hun: "Hungarian", ita: "Italian", jpn: "Japanese", kor: "Korean",
  lav: "Latvian", lit: "Lithuanian", nor: "Norwegian", pol: "Polish",
  por: "Portuguese", rus: "Russian", spa: "Spanish", swe: "Swedish",
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

/* ---------------- get-started checklist status ---------------------------- */

/** Steps 1-2 of the 🚀 card are verifiable from here (folder + site); the
 *  Open WebUI-side steps (skill, interpreter) are instructions only.
 *  The skill-file link ADAPTS: with a bridge token set, point at the
 *  token variant (its bootstrap ships with the token pre-filled). */
async function renderStart() {
  const el = document.getElementById("startstat");
  if (!el) return;
  try {
    const roots = (lastHealth && lastHealth.roots) || [];
    const site = await secAllowedSiteRead();
    const token = await OFBIDB.get("kv", "bridge_token");
    const parts = [];
    parts.push(roots.length ? "✓ folder connected" : "○ no folder yet");
    parts.push(site ? "✓ site allowed" : "○ no site allowed yet");
    parts.push("→ steps 3–4 happen in Open WebUI (skill + code interpreter)");
    el.textContent = parts.join(" · ");
    const link = document.getElementById("skillfile");
    const name = document.getElementById("skillfilename");
    if (link && name) {
      const which = token ? SKILL_FILE_TOKEN : SKILL_FILE_PLAIN;
      link.href = SKILL_FILE_BASE + which;
      name.textContent = which + (token ? " — token variant, because you set a bridge token" : "");
    }
  } catch (e) { /* status is UX */ }
}

/* ---------------- heartbeat (/health every 5 s) ---------------------------- */

let lastHealth = null; // {ok, roots:[{id,path,perm}], addons, ocr_lang, ...}
let langSig = "";      // last rendered language-box signature (avail|current)
let langSaved = new Set();  // stored lang set — the empty-tick guard restores from it

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
    " · security: " + (r.data.security === "UNLOCKED" ? "⚠ LOCKED — add a site below"
      : (r.data.security || "extension")) +
    (roots.length
      ? (needPerm.length
        ? " · ⚠ " + needPerm.length + " folder" + (needPerm.length > 1 ? "s" : "") + " need Reconnect"
        : " · " + roots.map((x) => x.path).join(", "))
      : " · no folder chosen yet");
  // engines card state (lives in the SW, not this page — hence the pipe).
  // addons = bundled capability; engine_alive = the engine host's heartbeat
  // (idle is the NORMAL resting state — engines auto-start on first use).
  const eng = r.data.addons || { pdf: false, ocr: false };
  const alive = !!r.data.engine_alive;
  document.getElementById("engstat").innerHTML =
    "PDF &amp; OCR engines " + (eng.pdf && eng.ocr ? "bundled" : "missing??") + " · " +
    (alive ? '<span class="ok">running (invisible)</span>'
      : '<span class="ok">idle — auto-starts on the first PDF/OCR call</span> ' +
        "(nothing to open; the first call takes a few seconds extra)");
  // language boxes depend on engine aliveness (available list comes empty
  // otherwise). Ticks apply immediately, so re-rendering from /health is
  // always safe; the signature check only avoids needless DOM churn.
  const sig = (r.data.ocr_langs_available || []).join(",") + "|" + (r.data.ocr_lang || "");
  if (sig !== langSig) {
    langSig = sig;
    renderLangs(r.data.ocr_langs_available || [], r.data.ocr_lang || "eng");
  }
  renderStart();
}

/* ---------------- security card (fs-sec: one site + token) ---------------- */

function normalizeSite(raw) {
  const s = String(raw || "").trim();
  if (!s) return { err: "enter an address first" };
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s) ? s : "https://" + s;
  let u;
  try { u = new URL(withScheme); } catch (e) { return { err: "not a valid address" }; }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { err: "only http(s) addresses can be allowed" };
  }
  return { origin: u.origin };
}

const SKILL_FILE_PLAIN = "SKILL-EXT.md";
const SKILL_FILE_TOKEN = "SKILL-EXT-TOKEN.md";
const SKILL_FILE_BASE =
  "https://github.com/Sparkling-AI/open-file-bridge/blob/master/skill/open-file-bridge/";

// site editor has three states: EMPTY (input + "Set site"), SET (view row
// with Edit/Remove — no input, so the set site is impossible to miss), and
// EDITING (input prefilled + "Save"). The flag survives re-renders so a
// visibilitychange mid-edit never clobbers the field.
let siteEditing = false;

async function renderSec() {
  const site = await secAllowedSiteRead();
  const token = await OFBIDB.get("kv", "bridge_token");

  const row = document.getElementById("siterow");
  const input = document.getElementById("siteadd");
  const btn = document.getElementById("siteaddbtn");
  const view = document.getElementById("siteview");
  const showInput = !site || siteEditing;
  row.style.display = showInput ? "" : "none";
  btn.textContent = siteEditing ? "Save" : "Set site";
  if (siteEditing && document.activeElement !== input) input.value = site || "";

  view.innerHTML = "";
  if (site && !siteEditing) {
    const r = document.createElement("div");
    r.className = "root-row";
    const name = document.createElement("span");
    name.className = "name";
    name.innerHTML = "🔒 <b>" + esc(site) + "</b> — the only site that can use the bridge";
    const edit = document.createElement("button");
    edit.className = "small secondary";
    edit.textContent = "Edit";
    edit.onclick = () => {
      siteEditing = true;
      renderSec();
      const i = document.getElementById("siteadd");
      i.focus();
      try { i.select(); } catch (e) {}
    };
    const del = document.createElement("button");
    del.className = "small secondary";
    del.textContent = "Remove";
    del.onclick = async () => {
      siteEditing = false;
      await OFBIDB.del("kv", "allowed_site");
      try { await OFBIDB.del("kv", "allowed_origins"); } catch (e) {}
      document.getElementById("siteadd").value = "";
      renderSec(); beat();
    };
    r.append(name, edit, del);
    view.appendChild(r);
  }

  const modeEl = document.getElementById("secmodeinfo");
  const mode = site ? (token ? "site lock + token" : "site lock") : (token ? "token only" : "nothing");
  modeEl.innerHTML = "Current protection: <b>" + esc(mode) + "</b>" +
    (site || token ? "" :
      " — <span class='warn'>no site can use the bridge yet; set your Open WebUI address above.</span>");
  modeEl.className = "hint";

  // recently-blocked suggestions — one click REPLACES the current site
  const denied = (await OFBIDB.get("kv", "denied_origins")) || [];
  const drows = document.getElementById("deniedrows");
  const fresh = denied.filter((d) => d && d.o && d.o !== site &&
    Date.now() - (d.ts || 0) < 3600 * 1000);
  drows.innerHTML = "";
  if (fresh.length) {
    const label = document.createElement("p");
    label.className = "hint";
    label.style.margin = "10px 0 0 0";
    label.textContent = "Recently blocked by the bridge — is one of these your Open WebUI? Clicking replaces the current site:";
    drows.appendChild(label);
    for (const d of fresh.slice(0, 8)) {
      const row = document.createElement("div");
      row.className = "root-row";
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = d.o;
      const add = document.createElement("button");
      add.className = "small secondary";
      add.textContent = "Use this site";
      add.onclick = async () => {
        siteEditing = false;
        await OFBIDB.put("kv", d.o, "allowed_site");
        try { await OFBIDB.del("kv", "allowed_origins"); } catch (e) {}
        renderSec(); beat();
      };
      row.append(name, add);
      drows.appendChild(row);
    }
  }

  const tokInput = document.getElementById("bridgetoken");
  if (document.activeElement !== tokInput) tokInput.value = token || "";
  document.getElementById("tokenstat").textContent = token
    ? "✓ token required from every chat request"
    : "no token — the site lock alone guards the bridge";
  renderStart();
}

/** options-page read of the one site (mirrors fs-sec's migration). */
async function secAllowedSiteRead() {
  const one = await OFBIDB.get("kv", "allowed_site");
  if (typeof one === "string" && one) return one;
  const legacy = (await OFBIDB.get("kv", "allowed_origins")) || [];
  return Array.isArray(legacy) && legacy.length ? legacy[0] : null;
}

function genToken() {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_")
    .replace(/=+$/, "");
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
    document.getElementById("engauto").checked =
      s.engine_auto_open === undefined ? true : !!s.engine_auto_open;
    const cs = document.getElementById("confirmscope");
    cs.value = ["off", "destructive", "all"].includes(s.confirm_scope)
      ? s.confirm_scope : "all";
    document.getElementById("confirmstat").textContent = "✓";
    renderRoots();
    renderSec();
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
  langSaved = sel;
  const order = [...(avail || [])].sort((a, b) =>
    (LANG_NAMES[a] || a).localeCompare(LANG_NAMES[b] || b));
  box.innerHTML = order.length ? order.map((c) =>
    "<label><input type=\"checkbox\" value=\"" + esc(c) + "\"" +
    (sel.has(c) ? " checked" : "") + "> " + esc(c) +
    (LANG_NAMES[c] ? " — " + LANG_NAMES[c] : "") + "</label>").join(" ")
    : '<span class="hint">no bundled languages available in this build</span>';
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
    // Location: the folder's full path on this computer, typed by the
    // user ONCE (the File System Access API never reveals it — only the
    // folder's name). File-link pages show/copy ABSOLUTE paths when set.
    const locBtn = document.createElement("button");
    locBtn.className = "small secondary";
    locBtn.textContent = "Location" + (r.os_path ? " ✓" : "…");
    locBtn.title = "Full path of this folder on your computer (e.g. /Users/you/Documents/" +
      (r.alias || "folder") + "). Optional — file-link pages then show and copy " +
      "openable absolute paths instead of folder-relative ones.";
    locBtn.onclick = () => {
      if (row.querySelector("input.loc")) return;
      const inp = document.createElement("input");
      inp.className = "loc";
      inp.placeholder = "/full/path/to/" + (r.alias || "folder");
      inp.value = r.os_path || "";
      inp.style.cssText =
        "flex:1;min-width:10em;height:30px;border-radius:7px;border:1px solid #b9b9c9;" +
        "padding:0 10px;font-size:13px;font-family:inherit";
      let done = false;
      const save = async () => {
        if (done) return;
        done = true;
        const v = inp.value.trim().replace(/\/+$/, "");
        if (v) r.os_path = v; else delete r.os_path;
        await OFBIDB.put("roots", r);
        renderRoots();
        status(v ? "Folder location saved — file-link pages now copy absolute paths"
          : "Folder location cleared", "ok");
      };
      inp.onkeydown = (ev) => {
        if (ev.key === "Enter") save();
        else if (ev.key === "Escape") { done = true; renderRoots(); }
      };
      inp.onblur = () => save();
      row.insertBefore(inp, locBtn);
      inp.focus();
    };
    if (r.os_path) name.title = r.os_path;
    row.append(name, perm, toggle, locBtn, del);
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
      const dbReq = indexedDB.open("ofb-ext"); // VERSIONLESS — a pinned version throws VersionError after fs-idb upgrades
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

  // Security card: ONE site + bridge token (fs-sec tiers 1 & 2)
  document.getElementById("siteaddbtn").onclick = async () => {
    const stat = document.getElementById("sitestat");
    const n = normalizeSite(document.getElementById("siteadd").value);
    if (n.err) { stat.textContent = "✗ " + n.err; return; }
    await OFBIDB.put("kv", n.origin, "allowed_site");
    try { await OFBIDB.del("kv", "allowed_origins"); } catch (e) {}
    document.getElementById("siteadd").value = "";
    stat.textContent = "";
    siteEditing = false;
    renderSec(); beat();
  };
  document.getElementById("siteadd").addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") document.getElementById("siteaddbtn").click();
  });
  document.getElementById("tokenset").onclick = async () => {
    const v = document.getElementById("bridgetoken").value.trim();
    if (v && v.length < 8) {
      document.getElementById("tokenstat").textContent = "✗ use at least 8 characters (or Generate)";
      return;
    }
    if (v) await OFBIDB.put("kv", v, "bridge_token");
    else await OFBIDB.del("kv", "bridge_token");
    document.getElementById("tokenstat").textContent =
      v ? "✓ token saved — chats must now present it" : "token cleared — site list alone guards the bridge";
    renderSec(); beat();
  };
  document.getElementById("tokengen").onclick = () => {
    document.getElementById("bridgetoken").value = genToken();
    document.getElementById("tokengen").textContent = "New"; // next click replaces again
    document.getElementById("tokenstat").textContent = "generated — press Save to activate";
  };
  document.getElementById("tokencopy").onclick = async () => {
    const v = document.getElementById("bridgetoken").value.trim();
    try {
      await navigator.clipboard.writeText(v);
      document.getElementById("tokenstat").textContent = "✓ copied — paste it in chat when the assistant asks";
    } catch (e) {
      document.getElementById("tokenstat").textContent = "copy failed — select the field and copy manually";
    }
  };

  // OCR ticks apply immediately (no Save button — a tick that shows but
  // isn't stored is a lie). The ✓ line under the box is the readout.
  document.getElementById("langbox").addEventListener("change", async () => {
    const v = [...document.querySelectorAll("#langbox input:checked")].map((x) => x.value).join("+");
    const stat = document.getElementById("langs");
    if (!v) {  // at least one language must stay on — restore the stored set
      document.querySelectorAll("#langbox input").forEach((x) => { x.checked = langSaved.has(x.value); });
      stat.textContent = "✗ keep at least one language ticked — still using the saved set";
      return;
    }
    const r = await pipe("POST", "/ocr/lang", { lang: v });
    if (r.ok) langSaved = new Set(String(r.data.ocr_lang).split("+"));
    langSig = "";  // force re-render from the saved value on the next beat
    stat.textContent = r.ok ? "✓ OCR language: " + r.data.ocr_lang : "✗ " + (r.error || "failed");
    beat();
  });

  document.getElementById("saveignore").onclick = async () => {
    const pats = document.getElementById("ignorepats").value.split("\n")
      .map((s) => s.trim()).filter(Boolean);
    await OFBIDB.put("kv", pats, "ignore_global");
    document.getElementById("ignstat").textContent =
      "✓ saved — " + (pats.length ? pats.length + " pattern" + (pats.length > 1 ? "s" : "") : "ignoring nothing extra");
    renderPreview();
  };

  // Selects apply on change (same as confirm-scope); refresh() sets the
  // value programmatically, which fires no change event — no save loop.
  document.getElementById("linkttl").addEventListener("change", async () => {
    const v = parseInt(document.getElementById("linkttl").value, 10);
    if (Number.isFinite(v)) {
      await OFBIDB.put("kv", v, "link_ttl");
      document.getElementById("ttlinfo").textContent = "Links live " + fmtTTL(v) + " ✓";
    }
  });

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

  document.getElementById("engauto").onchange = async (ev) => {
    await OFBIDB.put("kv", ev.target.checked, "engine_auto_open");
    document.getElementById("engautostat").textContent =
      ev.target.checked ? "— active" : "";
  };

  document.getElementById("confirmscope").onchange = async (ev) => {
    await OFBIDB.put("kv", ev.target.value, "confirm_scope");
    document.getElementById("confirmstat").textContent =
      "✓ " + (ev.target.value === "all" ? "delete + overwrite"
        : ev.target.value === "destructive" ? "delete only" : "off");
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
    if (document.visibilityState === "visible") { beat(); renderSec(); renderPreview(); renderAudit(); }
  });
});
