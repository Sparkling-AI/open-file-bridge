// Open File Bridge — engine RPC bridge (Stage 3, P3/P4).
//
// The engines (pdfium-WASM, tesseract.js, pdf-lib) run in an ENGINE HOST
// document (plan §4.2): the SW cannot importScripts wasm and WASM
// re-instantiation per SW cold start would burn the 5-min MV3 cap.
// fsRoute calls fsEngineRoute() which forwards to the host over
// chrome.runtime messaging.
//
// Host = an OFFSCREEN document since 2026-09-09 (invisible — no tab, no
// window; the SW starts it on demand when an engine endpoint is first
// called, default ON via kv "engine_auto_open"). The visible
// engine-host.html tab remains as the manual fallback (settings button)
// and for older Chrome without the offscreen API. If starting fails
// entirely, endpoints answer a structured 409 telling the model exactly
// what to ask the user for.

"use strict";

// Capability flags for /health (bundled since 3.0.0). Runtime availability
// is reported per-request: engine endpoints answer a structured 409
// engine_needed when the engine tab is closed.
const FS_ENGINES = { pdf: true, ocr: true };
const FS_OCR_LANGS = ["eng", "swe", "dan", "nor", "deu", "fra", "spa", "chi_sim"];

const FS_ENGINE_TIMEOUT_MS = 300000; // 5 min: OCR of a 50-page doc is slow
let FS_ENGINE_ALIVE = false;         // set by the page's hello/heartbeat

function fsEngineSetAlive(alive) {
  FS_ENGINE_ALIVE = !!alive;
}

async function fsEngineRoute(method, path, q, body) {
  if (path === "/pdf_text" && method === "GET") return await engineCall("pdf.text", q);
  if (path === "/ocr" && method === "GET") return await engineCall("ocr", q);
  if (path === "/ocr_pdf" && method === "POST") return await engineCall("ocr.pdf", body);
  if (path === "/pdf_op" && method === "POST") return await engineCall("pdf.op", body);
  return fsFail(404, { error: "unknown engine endpoint: " + path });
}

/** Forward an op to the engine page; resolve the input(s) here in the SW
 * (the page never touches the FS). Files cross the RPC as base64 bytes —
 * chrome.runtime.sendMessage structured-clones and DROPS File/Blob
 * instances (found 2026-09-06: "Image file /input cannot be read"). */

/** Setting gate for auto-start (kv "engine_auto_open", default ON since
 * 2026-09-07; meaning widened 2026-09-09): starting OUR OWN engine host is
 * not navigation and keeps the consent story — the settings page documents
 * it and can turn it off; 409 remains the fallback.
 * Read fresh on every engine op (no cache): ops take seconds, an IDB read
 * is noise, and the toggle must take effect on the very next request. */
async function engineAutoOpen() {
  return await kvGet("engine_auto_open", true);
}

/** Bring an engine host up, INVISIBLE first: an offscreen document (no
 * tab, no window — Dandan's ask, 2026-09-09). Falls back to the visible
 * engine-host.html background tab when the offscreen API is unavailable.
 * The caller then polls FS_ENGINE_ALIVE for the hello. Single-document
 * rule: createDocument throws when one already exists — that's success.
 * Returns a detail string for logs/409s, or null when nothing worked. */
async function engineEnsureHost(extraDetail) {
  if (chrome.offscreen && chrome.offscreen.createDocument) {
    try {
      try {
        await chrome.offscreen.createDocument({
          url: "engine-offscreen.html",
          reasons: ["BLOBS"],
          justification: "Runs the bundled WASM PDF/OCR engines (pdfium, tesseract.js, pdf-lib) — they cannot execute in the service worker.",
        });
      } catch (e) {
        // "Only a single offscreen document may be created" (or a race with
        // a concurrent engine call) — an existing host is exactly what we
        // want; anything else falls through to the tab fallback below.
        if (!/single offscreen document|already/i.test(String(e && e.message || e))) {
          return engineEnsureTab((extraDetail || "") + " | offscreen create failed: " +
            (e.message || e));
        }
      }
      return "engine host auto-started (offscreen, invisible) — retrying";
    } catch (e) {
      return engineEnsureTab((extraDetail || "") + " | offscreen unavailable: " +
        (e.message || e));
    }
  }
  return engineEnsureTab(extraDetail);
}

async function engineEnsureTab(extraDetail) {
  if (!chrome.tabs || !chrome.tabs.create) return extraDetail || null;
  try {
    await chrome.tabs.create({ url: "engine-host.html", active: false });
    return "engine tab auto-opened (background) — retrying";
  } catch (e) {
    return (extraDetail || "") + " | auto-open failed: " + (e.message || e);
  }
}

async function engineCall(op, params) {
  const payload = Object.assign({}, params);
  try {
    async function packOne(p) {
      const rg = await resolveGuarded(unquoteComp(String(p)), {});
      const name = rg.parts[rg.parts.length - 1];
      return { name: name, rel: rg.relInRoot, b64: await fileB64(rg) };
    }
    if (op === "pdf.op") {
      const paths = Array.isArray(params.paths) && params.paths.length
        ? params.paths
        : (params.path ? [params.path] : []);
      if (!paths.length || paths.length > 20) {
        return fsFail(400, { error: "paths must be a 1-20 list" });
      }
      payload.__files = [];
      for (const p of paths) {
        const one = await packOne(p);
        if (engExtOf(one.name) !== ".pdf") {
          return fsFail(400, { error: "input must be .pdf, not " + engExtOf(one.name) });
        }
        payload.__files.push(one);
      }
      payload.path = params.path || (params.paths && params.paths[0]);
    } else {
      payload.__file = await packOne(params.path || "");
    }
  } catch (e) {
    return opFailToResp(e);
  }

  // validate + preflight the OUTPUT path for write ops (before engines run)
  let outRg = null;
  try {
    if (op === "pdf.op" || op === "ocr.pdf") {
      const outRel = String(params.out || "");
      if (!outRel) return fsFail(400, { error: "missing out" });
      if (!outRel.toLowerCase().endsWith(".pdf")) return fsFail(400, { error: "out must end in .pdf" });
      outRg = await resolveGuarded(unquoteComp(outRel), { forWrite: true });
    }
  } catch (e) {
    return opFailToResp(e);
  }

  // call the page
  let reply;
  try {
    reply = await new Promise((resolve, reject) => {
      (async () => {
        if (!FS_ENGINE_ALIVE && !enginePageMaybeOpen()) {
          // auto-open path (kv "engine_auto_open", default ON): open our own
          // engine page in a background tab, wait for its hello, then run
          // the op; 409 engine_needed remains the fallback (setting off or
          // open failed / timed out).
          if (await engineAutoOpen()) {
            const detail = await engineEnsureHost();
            const t0 = Date.now();
            while (!FS_ENGINE_ALIVE && Date.now() - t0 < 15000) {
              await new Promise((r) => setTimeout(r, 300));
            }
            if (!FS_ENGINE_ALIVE) {
              reject(new OpFail(409, engineNeededBody(
                "auto-start: engine host did not come up within 15s" +
                (detail ? " (" + detail + ")" : ""))));
              return;
            }
          } else {
            reject(new OpFail(409, engineNeededBody()));
            return;
          }
        }
        const sendOnce = () => new Promise((res2, rej2) => {
          let settled = false;
          const timer = setTimeout(() => {
            if (!settled) { settled = true; res2({ ok: false, error: "engine timeout" }); }
          }, FS_ENGINE_TIMEOUT_MS);
          chrome.runtime.sendMessage({ ofbEngine: true, op: op, payload: payload }, (resp) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (chrome.runtime.lastError) {
              rej2(new Error("engine page not reachable: " + chrome.runtime.lastError.message));
              return;
            }
            res2(resp || { ok: false, error: "engine page returned nothing" });
          });
        });
        try {
          resolve(await sendOnce());
        } catch (e1) {
          // STALE HEARTBEAT: the page pinged once and later died — the
          // heartbeat has no dead-man reset, so FS_ENGINE_ALIVE can lie.
          // Correct it and retry ONCE through the auto-open path.
          fsEngineSetAlive(false);
          if (await engineAutoOpen()) {
            try {
              await engineEnsureHost();
              const t0 = Date.now();
              while (!FS_ENGINE_ALIVE && Date.now() - t0 < 15000) {
                await new Promise((r) => setTimeout(r, 300));
              }
            } catch (e2) { /* fall through to the honest 409 */ }
            if (FS_ENGINE_ALIVE) {
              try { resolve(await sendOnce()); }
              catch (e3) {
                reject(new Error("engine page not reachable after retry: " +
                  (e3.message || e3)));
              }
              return;
            }
          }
          reject(e1);
        }
      })(); // async IIFE inside the Promise executor
    });
  } catch (e) {
    if (e instanceof OpFail) return opFailToResp(e);
    return fsFail(409, engineNeededBody(String(e.message || e)));
  }
  if (!reply.ok) {
    // the page reported a domain error (bad ext, engine failure…)
    const m = String(reply.error || "engine error");
    const known = m.match(/^(\d{3})\|(.*)$/);
    if (known) return fsFail(parseInt(known[1], 10), { error: known[2] });
    return fsFail(500, { error: m });
  }
  const result = reply.result || {};

  // write outputs through the guarded write path (snapshot-first, breaker)
  try {
    if (result.__writeFile) {
      const res = await engineWriteOut(result.__writeFile);
      const out = Object.assign({}, result);
      delete out.__writeFile;
      return fsOk(Object.assign(out, res));
    }
    if (result.__writeFiles) {
      const results = [];
      for (const w of result.__writeFiles) results.push(await engineWriteOut(w));
      const out = Object.assign({}, result);
      delete out.__writeFiles;
      out.write_results = results;
      return fsOk(out);
    }
  } catch (e) {
    return opFailToResp(e);
  }
  return fsOk(result);
}

/** Write engine output (b64 payload): rate-breaker + snapshot-first +
 *  audit — same semantics as the /write family. Returns {written, bytes,
 *  snapshot}. */
async function engineWriteOut(w) {
  let bytes;
  try { bytes = b64dec(w.b64); }
  catch (e) { throw new OpFail(500, { error: "engine produced bad b64" }); }
  if (!bytes.length) throw new OpFail(500, { error: "engine produced no bytes" });
  if (bytes.length > MAX_BINARY) {
    throw new OpFail(413, { error: "engine output too large: " + bytes.length + " > " + MAX_BINARY });
  }
  const rg = await resolveGuarded(unquoteComp(String(w.rel || "")), { forWrite: true });
  const rc = await rateCheck(bytes.length);
  if (!rc.ok) throw new OpFail(429, { error: rc.err, rate_limited: true });
  const snap = await snapshotBeforeWrite(rg.rootRec, rg.parts);
  await writeFileBytes(rg.rootRec, rg.parts, bytes);
  await auditRow({ endpoint: "/pdf_op", method: "POST", path: rg.relInRoot, size: bytes.length, status: 200 });
  return { written: "/" + rg.relInRoot, bytes: bytes.length, snapshot: snap };
}

function enginePageMaybeOpen() {
  // engine-host pings on load + every 30s; if it ever pinged we optimistically
  // forward (sendMessage fails cleanly if the page died since)
  return FS_ENGINE_ALIVE;
}

/** Read the guarded file as base64 (the RPC channel is structured-clone:
 *  only plain strings/arrays survive). */
async function fileB64(rg) {
  const f = await getFileFor(rg.rootRec, rg.parts);
  if (f.size > MAX_BINARY) {
    throw new OpFail(413, { error: "input too large for the engine channel: " + f.size + " > " + MAX_BINARY });
  }
  return b64enc(new Uint8Array(await f.arrayBuffer()));
}

function engExtOf(name) {
  const m = String(name).match(/(\.[^.]+)$/);
  return m ? m[1].toLowerCase() : "";
}

function engineNeededBody(extra) {
  const b = {
    error: "PDF/OCR engines could not be started",
    engine_needed: true,
    hint: "engines normally auto-start (invisibly, offscreen) when an engine endpoint is called — retry ONCE; if this 409 persists, tell the user: click the Open File Bridge toolbar icon and open the engine tab manually (settings → Open engine tab)",
  };
  if (extra) b.detail = extra;
  return b;
}

/* ---- zip helpers (used by /zip + /unzip in fs-writes.js) ---- */

async function fsZipBytes(items) {
  // items: [{name, file}] — STORE-method zip (correct, readable by every
  // unzipper, just uncompressed). Deflate via the engine page if it grows
  // into a need.
  const chunks = [];
  const central = [];
  let offset = 0;
  const enc = new TextEncoder();
  const crc32 = makeCrc32();
  for (const it of items) {
    const bytes = new Uint8Array(await it.file.arrayBuffer());
    const nameBytes = enc.encode(it.name);
    const crc = crc32(bytes);
    const lh = new Uint8Array(30 + nameBytes.length);
    const dv = new DataView(lh.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);          // version needed
    dv.setUint16(6, 0, true);           // flags
    dv.setUint16(8, 0, true);           // method STORE
    dv.setUint16(10, 0, true);          // time
    dv.setUint16(12, 0x21, true);       // date (1980-1-1)
    dv.setUint32(14, crc, true);
    dv.setUint32(18, bytes.length, true);
    dv.setUint32(22, bytes.length, true);
    dv.setUint16(26, nameBytes.length, true);
    dv.setUint16(28, 0, true);
    lh.set(nameBytes, 30);
    chunks.push(lh, bytes);
    central.push({ nameBytes, crc, size: bytes.length, offset });
    offset += lh.length + bytes.length;
  }
  const cdChunks = [];
  let cdSize = 0;
  for (const c of central) {
    const ch = new Uint8Array(46 + c.nameBytes.length);
    const dv = new DataView(ch.buffer);
    dv.setUint32(0, 0x02014b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 20, true);
    dv.setUint16(8, 0, true);
    dv.setUint16(10, 0, true);
    dv.setUint16(12, 0x21, true);
    dv.setUint32(16, c.crc, true);
    dv.setUint32(20, c.size, true);
    dv.setUint32(24, c.size, true);
    dv.setUint16(28, c.nameBytes.length, true);
    dv.setUint32(42, c.offset, true);
    ch.set(c.nameBytes, 46);
    cdChunks.push(ch);
    cdSize += ch.length;
  }
  const eocd = new Uint8Array(22);
  const dv = new DataView(eocd.buffer);
  dv.setUint32(0, 0x06054b50, true);
  dv.setUint16(8, central.length, true);
  dv.setUint16(10, central.length, true);
  dv.setUint32(12, cdSize, true);
  dv.setUint32(16, offset, true);
  const total = offset + cdSize + 22;
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  for (const c of cdChunks) { out.set(c, p); p += c.length; }
  out.set(eocd, p);
  return out;
}

function makeCrc32() {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return (bytes) => {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  };
}

async function fsUnzipList(bytes) {
  const entries = [];
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip (no EOCD)");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("bad central directory");
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    const isDir = name.endsWith("/");
    entries.push({ name, dir: isDir, method, compSize, lho });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function fsUnzipEntry(bytes, name) {
  const list = await fsUnzipList(bytes);
  const e = list.find((x) => x.name === name);
  if (!e) throw new Error("no member " + name);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const lho = e.lho;
  const nameLen = dv.getUint16(lho + 26, true);
  const extraLen = dv.getUint16(lho + 28, true);
  const dataStart = lho + 30 + nameLen + extraLen;
  const comp = bytes.subarray(dataStart, dataStart + e.compSize);
  if (e.method === 0) return new Uint8Array(comp); // STORE
  // deflate: DecompressionStream is available in SW + pages (Chrome 103+)
  const ds = new DecompressionStream("deflate");
  const stream = new Blob([comp]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}
