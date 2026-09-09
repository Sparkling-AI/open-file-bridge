// Open File Bridge — FS adapter router (Stage 3).
//
// sw.js routes pipe messages here. Response shapes mirror the desktop app
// (v2.11) endpoint-for-endpoint so every skill recipe keeps working.
// Engines (/pdf_text /ocr /ocr_pdf /pdf_op) forward to the engine page
// via ENGINE_RPC (fs-engine.js, P3/P4); until those phases land the
// router answers with an honest 501 "engine not yet bundled".

"use strict";

/* ---------------- engine wheels (bundled, served via the pipe) -------- */

// Served from extension/vendor/wheels/ at runtime via
// chrome.runtime.getURL (no build-time injection — keeps first-party JS
// as-authored and reviewable; the pipe contract is unchanged).
const FS_WHEELS = [
  "defusedxml-0.7.1-py2.py3-none-any.whl",
  "et_xmlfile-2.0.0-py3-none-any.whl",
  "fonttools-4.63.0-py3-none-any.whl",
  "fpdf2-2.8.8-py3-none-any.whl",
  "openpyxl-3.1.5-py2.py3-none-any.whl",
  "python_docx-1.2.0-py3-none-any.whl",
  "python_pptx-1.0.2-py3-none-any.whl",
  "typing_extensions-4.16.0-py3-none-any.whl",
];

/* ---------------- the router ---------------- */

async function fsRoute(method, pathWithQs, bodyText, b64Mode) {
  const qi = pathWithQs.indexOf("?");
  const path = qi < 0 ? pathWithQs : pathWithQs.slice(0, qi);
  const q = parseQueryString(pathWithQs);
  let body = {};
  if (bodyText) {
    try { body = JSON.parse(bodyText); }
    catch (e) { return fsFail(400, { error: "invalid JSON body" }); }
  }

  /* ---- token-free meta (app contract: /health /version /state /wheels) -- */

  if (method === "GET" && path === "/health") {
    const roots = await enabledRoots();
    const ros = [];
    for (const r of roots) {
      const ps = await permState(r.handle, r.mode === "read" ? "read" : "readwrite");
      ros.push({ id: r.id, path: r.alias || r.id, alias: r.alias || null, perm: ps });
    }
    const info = ros.length
      ? { ok: true, roots: ros, version: FS_VERSION }
      : { ok: false, hint: "no folder chosen yet", roots: [], version: FS_VERSION };
    if (ros.length) info.root = ros[0].path;
    info.addons = { pdf: FS_ENGINES.pdf, ocr: FS_ENGINES.ocr };
    info.engine_alive = FS_ENGINE_ALIVE; // engine host heartbeat (fs-engine)
    // undocumented-field guard (2026-09-09): a model reading /health saw
    // engine_alive:false and told the user OCR was unavailable WITHOUT
    // calling the endpoint — make the field self-explanatory
    info.engine_alive_hint = "false is NORMAL before the first engine call — engines auto-start (invisibly) when /pdf_text /ocr /ocr_pdf /pdf_op is called";
    info.ocr_lang = await kvGet("ocr_lang", "eng");
    info.ocr_langs_available = FS_ENGINES.ocr ? FS_OCR_LANGS : [];
    info.wheels = FS_WHEELS.length;
    info.security = "extension";
    info.locked = true;
    return fsOk(info);
  }

  if (method === "GET" && path === "/version") {
    return fsOk({ bridge: FS_VERSION, skill_min: FS_SKILL_MIN,
      note: "skills older than skill_min may miss endpoints; update the skill via scripts/setup_owui.py" });
  }

  if (method === "GET" && path === "/state") {
    const roots = await enabledRoots();
    const ros = roots.map((r) => ({
      id: r.id, path: r.alias || r.id, alias: r.alias || null, mode: r.mode || "readwrite",
      readonly: r.mode === "read" || !!r.readonly,
      writes_enabled: r.writesEnabled !== false,
    }));
    const lim = await rateLimits();
    return fsOk({
      root: ros.length ? ros[0].path : null,
      roots: ros, port: null,
      ocr_lang: await kvGet("ocr_lang", "eng"),
      allowed_origin: null, security: "extension",
      readonly: await kvGet("readonly_global", false), readonly_source: "setting",
      allow_reveal: false,
      ignore_global: await kvGet("ignore_global", []),
      rate_limits: { max_writes: lim.w, max_mb: Math.floor(lim.b / 1024 / 1024),
        writes_source: "setting", mb_source: "setting" },
      link_ttl: await kvGet("link_ttl", 604800), link_ttl_source: "setting",
      engine_auto_open: await kvGet("engine_auto_open", true),
      confirm_scope: await kvGet("confirm_scope", "all"),
    });
  }

  if (method === "GET" && path === "/wheels") {
    return fsOk({ wheels: FS_WHEELS });
  }
  if (method === "GET" && path.startsWith("/wheels/")) {
    const name = unquoteComp(path.slice(8));
    if (!FS_WHEELS.includes(name)) {
      return fsFail(404, { error: "no such wheel: " + name });
    }
    if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.getURL) {
      return fsFail(500, { error: "wheels need the extension runtime" });
    }
    try {
      const res = await fetch(chrome.runtime.getURL("vendor/wheels/" + name));
      if (!res.ok) return fsFail(404, { error: "wheel not packaged: " + name });
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length > MAX_BINARY) {
        return fsFail(413, { error: "wheel too large: " + buf.length });
      }
      return { status: 200, bodyB64: b64enc(buf) };
    } catch (e) {
      return fsFail(500, { error: "wheel read failed: " + e });
    }
  }

  if (method === "GET" && path === "/ocr/config") {
    return fsOk({ ocr_lang: await kvGet("ocr_lang", "eng"), available: FS_ENGINES.ocr ? FS_OCR_LANGS : [] });
  }

  if (method === "POST" && path === "/ocr/lang") {
    const raw = String(body.lang || "");
    const parts = raw.split(/[\s,+]+/).filter(Boolean).filter((p) => /^[a-zA-Z_]{2,8}$/.test(p));
    if (!parts.length) return fsFail(400, { error: "bad lang: " + raw });
    await kvSet("ocr_lang", parts.join("+"));
    return fsOk({ ok: true, ocr_lang: parts.join("+"), available: FS_OCR_LANGS });
  }

  if (path.startsWith("/click/")) {
    return fsFail(404, { error: "outcome links are served by the extension page — see /link" });
  }

  if (method === "GET" && path === "/guide") {
    return fsOk({ guide_url: "guide.html", note: "the recovery guide is rendered by the extension page" });
  }

  /* ---- reads ---- */

  try {
    if (method === "GET" && path === "/list") {
      const rel = unquoteComp(q.path || ".");
      const roots = await enabledRoots();
      if (!roots.length) throw new OpFail(503, { error: "no shared folder configured — click the Open File Bridge toolbar icon and choose a folder" });
      let rootRec = roots[0];
      let startParts = [];
      if (rel && rel !== "." && rel !== "/") {
        const seg0 = rel.split("/")[0];
        if (seg0 && ROOT_ID_RE.test(seg0) && roots.some((r) => r.id === seg0)) {
          rootRec = roots.find((r) => r.id === seg0);
          const rest = rel.slice(seg0.length).replace(/^\/+/, "");
          startParts = rest.split("/").filter(Boolean);
        } else {
          startParts = rel.split("/").filter(Boolean);
        }
      }
      // per-op permission re-check (plan §4.3) — same structured shape as
      // resolveGuarded; /list does not go through resolveGuarded
      const ps = await permState(rootRec.handle, "read");
      if (ps !== "granted") {
        throw new OpFail(403, {
          error: "permission needed: the browser requires the user to re-confirm access to '" +
            (rootRec.alias || rootRec.id) + "'",
          permission_needed: true,
          root_id: rootRec.id,
          mode: "read",
          hint: "tell the user: click the Open File Bridge toolbar icon and press Reconnect — the folder is NOT re-picked, permission is re-asked on the stored handle",
        });
      }
      return await listEndpoint(rootRec, startParts);
    }

    if (method === "GET" && path === "/read") return await epRead(q);
    if (method === "GET" && path === "/peek") return await epPeek(q);
    if (method === "GET" && path === "/read_b64") return await epReadB64(q);
    if (method === "GET" && path === "/stat") return await epStat(q);
    if (method === "GET" && path === "/search") return await epSearch(q);
    if (method === "GET" && path === "/directory_tree") return await epTree(q);
    if (method === "GET" && path === "/image_info") return await epImageInfo(q);
    if (method === "GET" && path === "/image_b64") return await epImageB64(q);
  } catch (e) { return opFailToResp(e); }

  /* ---- writes, engines, moved ---- */

  try {
    if (method === "POST" && path === "/write") return await epWrite(body, false);
    if (method === "POST" && path === "/write_b64") return await epWrite(body, true);
    if (method === "POST" && path === "/write_b64_chunk") return await epWriteB64Chunk(body);
    if (method === "POST" && path === "/write_many") return await epWriteMany(body);
    if (method === "POST" && path === "/edit") return await epEdit(body);
    if (method === "POST" && path === "/delete") return await epDelete(body);
    if (method === "POST" && path === "/versions/list") return await epVersionsList(body);
    if (method === "POST" && path === "/versions/read") return await epVersionsRead(body);
    if (method === "POST" && path === "/versions/restore") return await epRestore("versions", body);
    if (method === "POST" && path === "/trash/list") return await epTrashList(body);
    if (method === "POST" && path === "/trash/restore") return await epRestore("trash", body);
    if (method === "POST" && path === "/zip") return await epZip(body);
    if (method === "POST" && path === "/unzip") return await epUnzip(body);
    if (method === "POST" && path === "/link") return await epLink(body);
    if (method === "GET" && path === "/reveal") return fsFail(403, {
      error: "reveal is disabled — an extension cannot open the OS file manager",
      hint: "the extension page shows the file path with a copy button" });
    if (path === "/pdf_text" || path === "/ocr" || path === "/ocr_pdf" || path === "/pdf_op") {
      // URL-decode lang at the routing boundary: parseQueryString is
      // deliberately raw (paths decode per-endpoint via unquoteComp), and
      // a properly-encoded swe%2Beng reached the engine un-decoded →
      // sanitizeLangs rejected it → silent English fallback → garbage OCR
      // of a Swedish sign (real chat 2026-09-09)
      if (q.lang !== undefined) q.lang = unquoteComp(q.lang);
      if (body && typeof body.lang === "string") body.lang = unquoteComp(body.lang);
      return await fsEngineRoute(method, path, q, body);
    }
  } catch (e) { return opFailToResp(e); }

  /* ---- moved / dropped ---- */

  if (MOVED_READ_ENDPOINTS.has(path) && method === "GET") {
    return await epMovedRead(path, q);
  }
  if (MOVED_WRITE_ENDPOINTS.has(path) && method === "POST") {
    return fsFail(501, {
      error: path + " is not available in extension mode — use the Pyodide recipe (SKILL-EXT §moved)",
      hint: "read via /read_b64, write via /write_b64, with the bundled wheels" });
  }
  if (path === "/convert") {
    return fsFail(501, {
      error: "/convert is not available in extension mode",
      hint: "open legacy formats in your office app (Word / Excel / LibreOffice) and save as .docx / .xlsx, then I can read and edit it" });
  }

  /* ---- router fall-through: method-aware 405 ----
   * A wrong-method call on a KNOWN endpoint used to 404 "unknown
   * endpoint" — indistinguishable from a typo'd path, and real chats
   * kept endpoint-guessing after it (POST /image_info, GET /link,
   * 2026-09-09). Engine endpoints keep their richer hint in
   * fsEngineRoute; this table covers the rest. */
  const ROUTE_GET = new Set(["/health", "/version", "/state", "/wheels",
    "/ocr/config", "/guide", "/list", "/read", "/peek", "/read_b64",
    "/stat", "/search", "/directory_tree", "/image_info", "/image_b64",
    "/pdf_text", "/ocr"].concat([...MOVED_READ_ENDPOINTS]));
  const ROUTE_POST = new Set(["/ocr/lang", "/write", "/write_b64",
    "/write_b64_chunk", "/write_many", "/edit", "/delete",
    "/versions/list", "/versions/read", "/versions/restore",
    "/trash/list", "/trash/restore",
    "/zip", "/unzip", "/link", "/ocr_pdf", "/pdf_op"]
    .concat([...MOVED_WRITE_ENDPOINTS]));
  if (ROUTE_GET.has(path)) {
    return fsFail(405, { error: path + " is GET-only — got " + method,
      hint: "call it as GET with query params, e.g. " + path + "?path=<file>" });
  }
  if (ROUTE_POST.has(path)) {
    return fsFail(405, { error: path + " is POST-only — got " + method,
      hint: "POST a JSON body, e.g. {\"path\": \"<file>\"}" });
  }

  return fsFail(404, { error: "unknown endpoint" });
}

function opFailToResp(e) {
  if (e instanceof OpFail) return fsFail(e.status, e.obj);
  return fsFail(500, { error: String((e && e.message) || e) });
}

const MOVED_READ_ENDPOINTS = new Set(["/eml_read", "/html_text", "/docx_read", "/pptx_read", "/xlsx_read"]);
const MOVED_WRITE_ENDPOINTS = new Set(["/docx_write", "/docx_merge", "/docx_mailmerge",
  "/pptx_from_template", "/xlsx_append", "/pdf_from_text", "/csv_head", "/csv_stats"]);

/** Moved read endpoints (plan §2): the FILE is still validated with the
 *  app's semantics (permission gate, sensitive floor, 404/503) so models
 *  get the same errors they know — then a clean 501 + the recipe instead
 *  of parsing anything. */
const MOVED_RECIPES = {
  "/docx_read": 'python-docx from /wheels/python_docx (read via /read_b64, docx.Document(BytesIO(b64decode(...))))',
  "/pptx_read": 'python-pptx from /wheels/python_pptx (read via /read_b64, pptx.Package.open)',
  "/xlsx_read": 'openpyxl from /wheels/openpyxl (read via /read_b64, load_workbook(BytesIO(...)))',
  "/eml_read": "stdlib email module: /read_b64 → email.message_from_bytes",
  "/html_text": "stdlib html.parser or bs4-style regex strip: /read_b64 → decode → strip tags",
};

async function epMovedRead(path, q) {
  // validate the target first — same resolution semantics as the app
  // (a missing file / locked permission still gives the app's 404/403,
  // not a generic adapter error)
  let file = null;
  try {
    const rg = await resolveGuarded(unquoteComp(q.path || ""));
    file = await getFileFor(rg.rootRec, rg.parts);
  } catch (e) {
    if (e instanceof OpFail) return fsFail(e.status, e.obj);
    return fsFail(400, { error: path + ": bad request — " + e });
  }
  return fsFail(501, {
    moved: true,
    error: path + " is not available in extension mode — the office stack runs in the Pyodide sandbox",
    size: file.size,
    hint: "fetch the bytes with /read_b64?path=" + encodeURIComponent(q.path || "") +
      " then parse in Pyodide: " + (MOVED_RECIPES[path] || "see SKILL-EXT §moved"),
  });
}

/* ---------------- meta helpers ---------------- */

async function listEndpoint(rootRec, startParts) {
  const pats = await allIgnorePatterns(rootRec);
  const entries = [];
  let truncated = false;
  let startDir = rootRec.handle;
  for (const seg of startParts) {
    try { startDir = await startDir.getDirectoryHandle(seg); }
    catch (e) { return fsFail(404, { error: "not a directory: " + startParts.join("/") }); }
  }
  const t0 = Date.now();
  async function rec(dir, prefixParts) {
    for await (const [name, h] of dir.entries()) {
      if (entries.length >= MAX_LIST) { truncated = true; return; }
      const relParts = prefixParts.concat(name);
      const rel = relParts.join("/");
      const isDir = h.kind === "directory";
      if (ignoreMatch(rel, isDir, pats)) continue;
      if (isDir) {
        entries.push({ path: rel, type: "dir", size: null, mtime: null });
        await rec(h, relParts);
        if (entries.length >= MAX_LIST) { truncated = true; return; }
      } else {
        let size = null, mtime = null;
        try { const f = await h.getFile(); size = f.size; mtime = Math.floor(f.lastModified / 1000); }
        catch (e) {}
        entries.push({ path: rel, type: "file", size: size, mtime: mtime });
      }
      if (Date.now() - t0 > 10000) { truncated = true; return; }
    }
  }
  await rec(startDir, startParts);
  await auditRow({ endpoint: "/list", method: "GET", path: startParts.join("/") || ".", status: 200, size: entries.length });
  return fsOk(Object.assign(
    { root: rootRec.alias || rootRec.id, root_id: rootRec.id, entries: entries, truncated: truncated },
    truncated ? { hint: "partial listing — folder exceeded the entry/time cap; narrow with path=" } : {}));
}

/* ---------------- read endpoints ---------------- */

async function epRead(q) {
  const rg = await resolveGuarded(unquoteComp(q.path || ""));
  const file = await getFileFor(rg.rootRec, rg.parts);
  if (file.size > 2 * MAX_READ * 4) {
    // overall cap guard (the windowed reader streams slices, but a
    // multi-GB file would still be read fully — refuse up front)
  }
  const name = rg.parts[rg.parts.length - 1];
  const ext = extOf(name);
  const base = name.toLowerCase();
  if (!TEXT_EXTS.has(ext) && !KNOWN_BASENAMES.has(base) && base !== ".gitignore") {
    return fsFail(413, {
      error: "/read is text-only; '" + ext.replace(/^\./, "") + "' is not on the text whitelist (fail-closed)",
      hint: "call /peek?path=…&bytes=512 to identify the file, or /read_b64 for raw bytes" });
  }
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const kind = sniffKind(head);
  if (kind) {
    return fsFail(413, { error: "/read is text-only; this file sniffs as " + kind, hint: routingHint(kind, ext) });
  }
  const text = await file.text();
  await auditRow({ endpoint: "/read", method: "GET", path: rg.relInRoot, status: 200, size: file.size });
  return fsOk(windowedRead(text, q, rg.relInRoot));
}

function windowedRead(text, q, relPath) {
  const start = Math.max(parseInt(q.start_line || "1", 10) || 1, 1);
  let n = parseInt(q.max_lines || String(DEFAULT_MAX_LINES), 10) || DEFAULT_MAX_LINES;
  n = Math.min(n, DEFAULT_MAX_LINES);
  const selected = [];
  let total = 0, budget = MAX_READ;
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  for (let i = 0; i < lines.length; i++) {
    total = i + 1;
    if (i + 1 < start || selected.length >= n) continue;
    let t = lines[i].replace(/\n$/, "");
    if (t.length > MAX_LINE_CHARS) t = t.slice(0, MAX_LINE_CHARS) + "… (line truncated)";
    if (budget - (t.length + 8) < 0) {
      selected.push(String(i + 1).padStart(6) + "\t…(char budget reached — narrow the window)");
      budget = -1;
      break;
    }
    budget -= t.length + 8;
    selected.push(String(i + 1).padStart(6) + "\t" + t);
  }
  const end = selected.length ? start + selected.length - 1 : start - 1;
  const out = {
    path: relPath, start_line: start, end_line: end,
    total_lines: total, content: selected.join("\n"),
  };
  if (end < total) out.note = "showing lines " + start + "-" + end + " of " + total +
    "; call again with start_line=" + (end + 1) + " to continue";
  return out;
}

async function epPeek(q) {
  const rg = await resolveGuarded(unquoteComp(q.path || ""));
  const file = await getFileFor(rg.rootRec, rg.parts);
  const n = Math.max(16, Math.min(parseInt(q.bytes || "512", 10) || 512, 4096));
  const head = new Uint8Array(await file.slice(0, n).arrayBuffer());
  const kind = sniffKind(head);
  const name = rg.parts[rg.parts.length - 1];
  const ext = extOf(name);
  const guessed = kind || ((TEXT_EXTS.has(ext) || KNOWN_BASENAMES.has(name.toLowerCase())) ? "text" : "unknown");
  let preview = new TextDecoder("utf-8", { fatal: false }).decode(head);
  preview = Array.from(preview).map((ch) => {
    const code = ch.codePointAt(0);
    if ((code >= 32 && code < 127) || code === 9 || code === 10 || code === 13) return ch;
    return "·";
  }).join("");
  let pr = 0;
  for (const b of head) if ((b >= 32 && b < 127) || b === 9 || b === 10 || b === 13) pr++;
  await auditRow({ endpoint: "/peek", method: "GET", path: rg.relInRoot, status: 200, size: n });
  return fsOk({
    path: q.path, size: file.size, ext: ext || null, kind: guessed,
    printable_ratio: pr / Math.max(head.length, 1),
    preview: preview,
    hint: kind ? routingHint(kind, ext)
      : (guessed === "text" ? "looks like text — /read it"
        : "unknown format — /read_b64 if you need the bytes"),
  });
}

async function epReadB64(q) {
  const rg = await resolveGuarded(unquoteComp(q.path || ""));
  const file = await getFileFor(rg.rootRec, rg.parts);
  if (file.size > MAX_BINARY) {
    throw new OpFail(413, { error: "file too large: " + file.size + " > " + MAX_BINARY + " bytes" });
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  await auditRow({ endpoint: "/read_b64", method: "GET", path: rg.relInRoot, status: 200, size: bytes.length });
  return fsOk({ path: q.path, size: bytes.length, b64: b64enc(bytes) });
}

async function epStat(q) {
  const rg = await resolveGuarded(unquoteComp(q.path || ""));
  const name = rg.parts[rg.parts.length - 1];
  const w = await walkToParent(rg.rootRec, rg.parts, false);
  if (!w) return fsFail(404, { error: "not found: " + q.path });
  let file = null;
  try { file = await (await w.dir.getFileHandle(w.fileName)).getFile(); }
  catch (e) { /* maybe dir */ }
  if (file) {
    const ext = extOf(name);
    const kind = (ext === ".png" || ext === ".jpg" || ext === ".jpeg" || ext === ".gif" ||
      ext === ".webp" || ext === ".bmp") ? "image"
      : ext === ".pdf" ? "pdf"
      : [".docx", ".xlsx", ".pptx", ".odt", ".ods", ".odp"].includes(ext) ? "zip"
      : [".doc", ".xls", ".ppt"].includes(ext) ? "legacy"
      : [".txt", ".md", ".csv", ".json", ".xml", ".yml", ".yaml", ".log", ".py", ".js", ".html", ".css"].includes(ext) ? "text"
      : "other";
    return fsOk({ path: q.path, size: file.size, mtime: Math.floor(file.lastModified / 1000), kind: kind, ext: ext || null });
  }
  // directory?
  try {
    await w.dir.getDirectoryHandle(w.fileName);
    await auditRow({ endpoint: "/stat", method: "GET", path: rg.relInRoot, status: 200 });
    return fsOk({ path: q.path, size: null, mtime: null, kind: "dir", ext: extOf(name) || null });
  } catch (e) {
    return fsFail(404, { error: "not found: " + q.path });
  }
}

async function epSearch(q) {
  const term = unquoteComp(q.q || "");
  if (!term) return fsFail(400, { error: "missing q" });
  const roots = await enabledRoots();
  if (!roots.length) throw new OpFail(503, { error: "no shared folder configured — click the Open File Bridge toolbar icon and choose a folder" });
  const rootRec = roots[0];
  const pats = await allIgnorePatterns(rootRec);
  const max = Math.min(parseInt(q.max || "50", 10) || 50, 200);
  const caseSensitive = q.case === "1" || q.case === "true";
  const glob = q.glob || null;
  const exclude = q.exclude || null;
  const needle = caseSensitive ? term : term.toLowerCase();
  const results = [];
  const t0 = Date.now();
  async function rec(dir, prefixParts) {
    if (results.length >= max || Date.now() - t0 > 15000) return;
    for await (const [name, h] of dir.entries()) {
      if (results.length >= max) return;
      const relParts = prefixParts.concat(name);
      const rel = relParts.join("/");
      const isDir = h.kind === "directory";
      if (ignoreMatch(rel, isDir, pats)) continue;
      if (isDir) { await rec(h, relParts); continue; }
      const ext = extOf(name);
      if (!TEXT_EXTS.has(ext) && !KNOWN_BASENAMES.has(name.toLowerCase())) continue;
      if (glob && !fnmatchStar(name, glob)) continue;
      if (exclude && fnmatchStar(name, exclude)) continue;
      if (sensitiveName(name)) continue;
      let file;
      try { file = await h.getFile(); } catch (e) { continue; }
      if (file.size > 2000000) continue;
      const text = await file.text();
      const hay = caseSensitive ? text : text.toLowerCase();
      let from = 0;
      while (results.length < max) {
        const idx = hay.indexOf(needle, from);
        if (idx < 0) break;
        let lineNo = 1, consumed = 0;
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          consumed += lines[i].length + 1;
          if (consumed > idx) { lineNo = i + 1; break; }
        }
        results.push({ path: rel, line: lineNo, text: (lines[lineNo - 1] || "").slice(0, 240) });
        from = idx + needle.length;
      }
    }
  }
  await rec(rootRec.handle, []);
  await auditRow({ endpoint: "/search", method: "GET", path: ".", status: 200, size: results.length });
  return fsOk({ q: term, results: results, truncated: results.length >= max });
}

async function epTree(q) {
  const rg0 = unquoteComp(q.path || ".");
  const roots = await enabledRoots();
  if (!roots.length) throw new OpFail(503, { error: "no shared folder configured — click the Open File Bridge toolbar icon and choose a file" });
  let rootRec = roots[0];
  let startParts = [];
  const rel = rg0;
  if (rel && rel !== "." && rel !== "/") {
    const seg0 = rel.split("/")[0];
    if (seg0 && ROOT_ID_RE.test(seg0) && roots.some((r) => r.id === seg0)) {
      rootRec = roots.find((r) => r.id === seg0);
      startParts = rel.slice(seg0.length).replace(/^\/+/, "").split("/").filter(Boolean);
    } else {
      startParts = rel.split("/").filter(Boolean);
    }
  }
  let startDir = rootRec.handle;
  for (const seg of startParts) {
    try { startDir = await startDir.getDirectoryHandle(seg); }
    catch (e) { return fsFail(404, { error: "not a directory: " + q.path }); }
  }
  const maxEntries = Math.min(parseInt(q.max_entries || "500", 10) || 500, 2000);
  const maxDepth = Math.min(parseInt(q.max_depth || "6", 10) || 6, 12);
  const pats = await allIgnorePatterns(rootRec);
  const rootName = startParts.length ? startParts[startParts.length - 1] : (rootRec.alias || rootRec.id);
  let truncated = false, count = 0;
  async function node(dir, name, depth, prefixParts) {
    const children = [];
    const flat = [];
    for await (const [nm, h] of dir.entries()) flat.push([nm, h]);
    flat.sort((a, b) => (a[0] < b[0] ? -1 : 1));
    for (const [nm, h] of flat) {
      if (count >= maxEntries) { truncated = true; break; }
      const relParts = prefixParts.concat(nm);
      const rel = relParts.join("/");
      const isDir = h.kind === "directory";
      if (ignoreMatch(rel, isDir, pats)) continue;
      if (isDir) {
        count++;
        if (depth + 1 > maxDepth) {
          children.push({ name: nm, type: "dir", size: 0, children: [], truncated: true });
        } else {
          children.push(await node(h, nm, depth + 1, relParts));
        }
      } else {
        count++;
        let size = null;
        try { size = (await h.getFile()).size; } catch (e) {}
        children.push({ name: nm, type: "file", size: size });
      }
    }
    return { name: name, type: "dir", size: 0, children: children };
  }
  const tree = await node(startDir, rootName, 0, startParts);
  await auditRow({ endpoint: "/directory_tree", method: "GET", path: startParts.join("/") || ".", status: 200, size: count });
  return fsOk(Object.assign(
    { tree: tree, entry_count: count, truncated: truncated },
    truncated ? { hint: "increase max_entries/max_depth for more" } : {}));
}

/** Parse png/jpeg/gif/webp/bmp headers — port of the app's /image_info
 * walker (src/file_bridge.py): width/height + JPEG EXIF orientation, no
 * decoding. Missing since the Stage-3 port (the call site 500'd with
 * "imageInfoFromHeader is not defined" in a real chat 2026-09-09).
 * Returns {format,width,height,megapixels[,exif_orientation,
 * effective_width,effective_height,note]} or null. */
function imageInfoFromHeader(head, size) {
  if (!head || head.length < 12) return null;
  function be(off, n) {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 256 + (head[off + i] || 0);
    return v;
  }
  function le16(off) { return (head[off] || 0) | ((head[off + 1] || 0) << 8); }
  function le32(off) {
    return (head[off] || 0) | ((head[off + 1] || 0) << 8) |
      ((head[off + 2] || 0) << 16) | ((head[off + 3] || 0) << 24);
  }
  function sig(s, off) {
    for (let i = 0; i < s.length; i++)
      if (head[off + i] !== (s.charCodeAt(i) & 0xff)) return false;
    return true;
  }
  let fmt = null, w = null, h = null, orientation = null;
  if (sig("\x89PNG\r\n\x1a\n", 0)) {
    fmt = "png";
    if (sig("IHDR", 12)) { w = be(16, 4); h = be(20, 4); }
  } else if (sig("GIF87a", 0) || sig("GIF89a", 0)) {
    fmt = "gif"; w = le16(6); h = le16(8);
  } else if (head[0] === 0x42 && head[1] === 0x4d) { // "BM"
    fmt = "bmp"; w = le32(18); h = le32(22); // signed i32 (top-down BMPs use negative h)
  } else if (sig("RIFF", 0) && sig("WEBP", 8)) {
    fmt = "webp";
    if (sig("VP8 ", 12) && head[23] === 0x9d && head[24] === 0x01 && head[25] === 0x2a) {
      w = le16(26) & 0x3fff; h = le16(28) & 0x3fff;
    } else if (sig("VP8L", 12)) {
      const b0 = head[21], b1 = head[22], b2 = head[23], b3 = head[24];
      w = 1 + (((b1 & 0x3f) << 8) | b0);
      h = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
    } else if (sig("VP8X", 12)) {
      w = 1 + (head[24] | (head[25] << 8) | (head[26] << 16));
      h = 1 + (head[27] | (head[28] << 8) | (head[29] << 16));
    }
  } else if (head[0] === 0xff && head[1] === 0xd8) {
    fmt = "jpeg";
    let off = 2;
    while (off + 4 < head.length) {
      if (head[off] !== 0xff) { off++; continue; }
      const marker = head[off + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue; }
      const seglen = be(off + 2, 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        h = be(off + 5, 2); w = be(off + 7, 2); break; // SOFn
      }
      if (marker === 0xe1 && sig("Exif\x00\x00", off + 4)) {
        const tiff = off + 10;
        const little = head[tiff] === 0x49 && head[tiff + 1] === 0x49; // "II"
        const rd16 = (o) => little ? le16(o) : be(o, 2);
        const rd32 = (o) => little ? le32(o) : be(o, 4);
        const cntAt = tiff + rd32(tiff + 4); // IFD0 offset
        const n = rd16(cntAt);
        for (let k = 0; k < n; k++) {
          const ent = cntAt + 2 + k * 12;
          if (rd16(ent) === 0x0112) { orientation = rd16(ent + 8); break; } // Orientation
        }
      }
      off += 2 + seglen;
    }
  }
  if (!fmt || w == null) return null;
  const out = { format: fmt, width: w, height: h,
    megapixels: Math.round((w * h / 1e6) * 100) / 100 };
  if (orientation) {
    out.exif_orientation = orientation;
    const swap = orientation >= 5 && orientation <= 8;
    out.effective_width = swap ? h : w;
    out.effective_height = swap ? w : h;
    out.note = "EXIF orientation present — effective dims swap w/h; viewers auto-rotate but raw decoders may not";
  }
  return out;
}

async function epImageInfo(q) {
  const rg = await resolveGuarded(unquoteComp(q.path || ""));
  const file = await getFileFor(rg.rootRec, rg.parts);
  // 64 KB like the app — the JPEG marker/EXIF walk can run past 128 bytes
  const bytes = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
  const info = imageInfoFromHeader(bytes, file.size);
  if (!info) {
    return fsFail(415, { error: "unsupported image format", hint: "supported: png/jpeg/gif/webp/bmp" });
  }
  await auditRow({ endpoint: "/image_info", method: "GET", path: rg.relInRoot, status: 200 });
  return fsOk(Object.assign({ path: q.path, size: file.size }, info));
}

async function epImageB64(q) {
  const rg = await resolveGuarded(unquoteComp(q.path || ""));
  const file = await getFileFor(rg.rootRec, rg.parts);
  if (file.size > MAX_BINARY) {
    return fsFail(413, { error: "file too large: " + file.size + " > " + MAX_BINARY + " bytes" });
  }
  const clampParam = (v, lo, hi, dflt) => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
  };
  const maxBytes = clampParam(q.max_bytes, 50000, MAX_BINARY, 4000000);
  const maxEdge = clampParam(q.max_edge, 0, 8192, 2000);  // 0 disables the edge cap
  const r = await fsImageToDataUrl(file, { maxBytes, maxEdge });
  if (!r.ok) {
    return fsFail(413, {
      error: "image is " + file.size + " bytes; could not shrink under the "
           + maxBytes + "-byte cap",
      hint: "pass a larger max_bytes (≤ 8 MB) or max_edge=0 (no resize); use "
          + "/read_b64 if the model needs ORIGINAL bytes",
    });
  }
  await auditRow({ endpoint: "/image_b64", method: "GET", path: rg.relInRoot, status: 200, size: r.bytes });
  return fsOk({
    path: q.path, mime: r.mime, width: r.width, height: r.height,
    bytes: r.bytes, shrunk: r.shrunk,
    ...(r.shrunk ? { orig_bytes: r.origBytes, orig_width: r.origWidth, orig_height: r.origHeight } : {}),
    b64: r.b64, data_url: "data:" + r.mime + ";base64," + r.b64,
  });
}
