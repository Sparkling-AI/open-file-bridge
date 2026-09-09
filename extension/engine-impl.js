// Open File Bridge — engine implementation (Stage 3, P3+P4).
//
// Loaded ONLY by the engine-host page (never the SW): the heavy engines
// (pdfium-WASM, tesseract.js, pdf-lib) instantiate here (plan §4.2).
// fs-engine.js (SW) forwards ops via chrome.runtime messaging; inputs arrive
// as base64 (the RPC structured-clones and drops File objects), outputs go
// back as bytes the SW writes through the guarded write path.
//
// Route decisions (proven in real Chromium, sessions #4-#5):
//   - pdfium = the PDF READER: text extraction + page render (input side).
//     Its SAVE path is unusable in this build: FPDF_SaveAsCopy needs a wasm-
//     table callback (addFunction NOT exported; WebAssembly.Function not
//     shipped in production Chromium). Dead ends documented 2026-09-06.
//   - pdf-lib (vendored UMD) = the PDF WRITER: /pdf_op split/merge/rotate
//     output, searchable-PDF assembly.
//   - tesseract.js = OCR: recognize() for /ocr; recognize(outputs:{pdf:true})
//     produces image + invisible-text-layer pages for /ocr_pdf (its own
//     TessPDFRenderer); pdf-lib merges them into the output file.
//   - langs: gzip:false + absolute chrome-extension:// langPath (first-class
//     options in tesseract.js 7) — plain .traineddata files.
//   - worker: workerBlobURL:false (blob importScripts is blocked in
//     extension pages); manifest CSP carries 'wasm-unsafe-eval' for the
//     wasm cores (MV3-sanctioned, no remote code).

"use strict";

const ENGINES = {
  pdfiumLib: null,      // PDFiumLibrary instance
  pdfLib: null,         // globalThis.PDFLib (pdf-lib UMD)
  tessWorker: null,     // current tesseract worker
  tessLang: null,       // lang string the worker was created with
};

const ENG_OCR_LANGS = ["eng", "swe", "dan", "nor", "deu", "fra", "spa", "chi_sim"];
const OCR_MAX_PAGES_DEFAULT = 5;      // /ocr on PDFs (app parity)
const OCR_PDF_MAX_PAGES = 50;         // /ocr_pdf cap (app parity)
const RASTER_SCALE = 2.0;             // /pdf_text?mode=images (app parity, ~144dpi)
const RASTER_MAX_PAGES = 100;
const PDF_OP_MAX_INPUTS = 20;         // app parity

function vendorUrl(rel) {
  return chrome.runtime.getURL("vendor/" + rel);
}

function b64ToBytes(b64) {
  const bin = atob(String(b64 || ""));
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

async function loadPdfLibGlobal() {
  if (ENGINES.pdfLib) return ENGINES.pdfLib;
  await loadScriptOnce(vendorUrl("pdflib/pdf-lib.min.js"), "pdf-lib");
  const L = globalThis.PDFLib;
  if (!L || !L.PDFDocument) throw new Error("pdf-lib did not load");
  ENGINES.pdfLib = L;
  return L;
}

const _loadedScripts = new Set();
function loadScriptOnce(url, name) {
  if (_loadedScripts.has(name)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = url;
    s.onload = () => { _loadedScripts.add(name); resolve(); };
    s.onerror = () => reject(new Error("failed to load " + name + " from " + url));
    document.head.appendChild(s);
  });
}

async function getPdfium() {
  if (ENGINES.pdfiumLib) return ENGINES.pdfiumLib;
  const mod = await import(vendorUrl("pdfium/index.esm.js"));
  const lib = await mod.PDFiumLibrary.init({ wasmUrl: vendorUrl("pdfium/pdfium.wasm") });
  ENGINES.pdfiumLib = lib;
  return lib;
}

/* ---------------- OCR worker management ---------------- */

function sanitizeLangs(raw) {
  const parts = String(raw || "").split(/[\s,+]+/).filter(Boolean);
  const valid = parts.filter((p) => /^[a-zA-Z_]{2,8}$/.test(p));
  return valid.length ? valid.join("+") : "eng";
}

async function getTessWorker(lang) {
  if (ENGINES.tessWorker && ENGINES.tessLang === lang) return ENGINES.tessWorker;
  if (ENGINES.tessWorker) {
    try { await ENGINES.tessWorker.terminate(); } catch (e) { /* stale */ }
    ENGINES.tessWorker = null;
  }
  if (typeof Tesseract === "undefined") {
    await loadScriptOnce(vendorUrl("tesseractjs/tesseract.min.js"), "tesseract");
  }
  const worker = await Tesseract.createWorker(lang, 1, {
    workerPath: vendorUrl("tesseractjs/worker.min.js"),
    workerBlobURL: false,   // blob importScripts is blocked in extension pages
    corePath: vendorUrl("tesseractjs/"),
    langPath: vendorUrl("tessdata-fast/"),
    gzip: false,            // plain .traineddata files
    logger: () => {},
  });
  ENGINES.tessWorker = worker;
  ENGINES.tessLang = lang;
  return worker;
}

/* ---------------- page rendering (pdfium -> PNG bytes) ---------------- */

async function renderPagePng(page, dpi) {
  const scale = (dpi || 200) / 72;
  const out = await page.render({
    scale,
    render: async (opts) => {
      const cnv = new OffscreenCanvas(opts.width, opts.height);
      const ctx = cnv.getContext("2d", { willReadFrequently: true });
      // pdfium BGRA + REVERSE_BYTE_ORDER => RGBA-ordered for canvas
      const img = new ImageData(new Uint8ClampedArray(opts.data), opts.width, opts.height);
      ctx.putImageData(img, 0, 0);
      const blob = await cnv.convertToBlob({ type: "image/png" });
      return new Uint8Array(await blob.arrayBuffer());
    },
  });
  return out; // { data: Uint8Array(png), width, height, ... }
}

/* ---------------- /ocr (app shape: pages[].lines[]) ---------------- */

async function opOcr(payload) {
  const lang = sanitizeLangs(payload.lang);
  const name = payload.__file ? payload.__file.name : "";
  const ext = extOfName(name);
  const maxPages = clampInt(payload.max_pages, 1, OCR_MAX_PAGES_DEFAULT, OCR_MAX_PAGES_DEFAULT);
  const dpi = clampInt(payload.dpi, 72, 400, 200);
  const worker = await getTessWorker(lang);
  const results = [];

  async function ocrImage(bytes) {
    let input = new Blob([bytes], { type: mimeFor(ext) });
    // small-photo upscale: tesseract's accuracy falls off a cliff on
    // small text — a real-world sign photo OCR'd as near-garbage with
    // every language (2026-09-09). Scale images whose short side is
    // under 800 px up to ~1200 px (max ×3) before recognizing. PDF
    // pages render at 200 dpi (~1650 px) and are never touched.
    try {
      const bmp = await createImageBitmap(new Blob([bytes], { type: mimeFor(ext) }));
      const m = Math.min(bmp.width, bmp.height);
      if (m > 0 && m < 800) {
        const scale = Math.min(1200 / m, 3);
        const cv = new OffscreenCanvas(
          Math.round(bmp.width * scale), Math.round(bmp.height * scale));
        const g = cv.getContext("2d");
        g.imageSmoothingEnabled = true;
        g.imageSmoothingQuality = "high";
        g.drawImage(bmp, 0, 0, cv.width, cv.height);
        input = await cv.convertToBlob({ type: "image/png" });
      }
      if (bmp.close) bmp.close();
    } catch (e) { /* decode/upscale failed — recognize the original bytes */ }
    const { data } = await worker.recognize(input);
    return data.text.split("\n").filter((l) => l.trim());
  }

  if (isImageExt(ext)) {
    results.push({ page: 1, lines: await ocrImage(b64ToBytes(payload.__file.b64)) });
  } else if (ext === ".pdf") {
    const doc = await getPdfium().then((lib) => lib.loadDocument(b64ToBytes(payload.__file.b64)));
    try {
      const total = doc.getPageCount();
      const n = Math.min(total, maxPages);
      for (let i = 0; i < n; i++) {
        const page = doc.getPage(i);
        const png = await renderPagePng(page, dpi);
        results.push({ page: i + 1, lines: await ocrImage(png.data) });
      }
      if (total > n) results.push({ page: n + 1, note: "truncated (max_pages)" });
    } finally {
      doc.destroy();
    }
  } else {
    throw engError(400, "OCR supports images and PDF, not " + ext);
  }
  return { path: payload.path, lang: lang, pages: results };
}

/* ---------------- /ocr_pdf (searchable PDF) ---------------- */

async function opOcrPdf(payload) {
  const outRel = String(payload.out || "");
  const lang = sanitizeLangs(payload.lang);
  const dpi = clampInt(payload.dpi, 72, 400, 200);
  const maxPages = clampInt(payload.max_pages, 1, OCR_PDF_MAX_PAGES, OCR_PDF_MAX_PAGES);
  if (!outRel.toLowerCase().endsWith(".pdf")) throw engError(400, "out must end in .pdf");
  const name = payload.__file ? payload.__file.name : "";
  const ext = extOfName(name);
  const worker = await getTessWorker(lang);

  let images = [];
  let skipped = 0;
  if (isImageExt(ext)) {
    images.push(b64ToBytes(payload.__file.b64));
  } else if (ext === ".pdf") {
    const doc = await getPdfium().then((lib) => lib.loadDocument(b64ToBytes(payload.__file.b64)));
    try {
      const total = doc.getPageCount();
      const n = Math.min(total, maxPages);
      for (let i = 0; i < n; i++) {
        const png = await renderPagePng(doc.getPage(i), dpi);
        images.push(png.data);
      }
      skipped = total - n;
    } finally {
      doc.destroy();
    }
  } else {
    throw engError(400, "ocr_pdf supports images and PDF, not " + ext);
  }
  if (!images.length) throw engError(400, "nothing to OCR (empty document?)");

  // recognize each page WITH pdf output -> image + invisible text layer
  const partPdfs = [];
  for (const imgBytes of images) {
    const blob = new Blob([imgBytes], { type: "image/png" });
    const { data } = await worker.recognize(blob, {}, { pdf: true, text: true });
    if (!data.pdf || data.pdf.length < 5 || head5(data.pdf) !== "%PDF-") {
      throw engError(500, "OCR pdf renderer failed on a page");
    }
    partPdfs.push(data.pdf);
  }

  // assemble with pdf-lib (copyPages keeps image + invisible layer)
  const L = await loadPdfLibGlobal();
  const merged = await L.PDFDocument.create();
  for (const part of partPdfs) {
    const pd = await L.PDFDocument.load(part, { ignoreEncryption: true });
    const cps = await merged.copyPages(pd, pd.getPageIndices());
    for (const cp of cps) merged.addPage(cp);
  }
  const pdfBytes = await merged.save();
  if (pdfBytes.length > MAX_BINARY) throw engError(413, "searchable PDF too large: " + pdfBytes.length + " > " + MAX_BINARY + " bytes");
  const resp = {
    __writeFile: { rel: outRel, b64: bytesToB64(pdfBytes) },
    ok: true, written: "/" + outRel.replace(/^\/+/, ""), pages: partPdfs.length,
    bytes: pdfBytes.length, lang: lang, dpi: dpi,
    note: "searchable PDF: page images + invisible text layer — /pdf_text and copy-paste search work on it now",
  };
  if (skipped) resp.pages_skipped = skipped;
  return resp;
}

/* ---------------- /pdf_text (text + images modes) ---------------- */

async function opPdfText(payload) {
  const mode = String(payload.mode || "text");
  const lib = await getPdfium();
  const doc = await lib.loadDocument(b64ToBytes(payload.__file.b64));
  try {
    const total = doc.getPageCount();
    const wanted = parsePagesParam(String(payload.pages || ""), total);
    if (mode === "images") {
      const maxPages = clampInt(payload.max_pages, 1, RASTER_MAX_PAGES, RASTER_MAX_PAGES);
      const pagesOut = [];
      let budget = MAX_BINARY;
      for (const i of wanted.slice(0, maxPages)) {
        const png = await renderPagePng(doc.getPage(i), 72 * RASTER_SCALE);
        const b64 = bytesToB64(png.data);
        budget -= b64.length;
        pagesOut.push({ page: i + 1, size: [png.width, png.height], png_b64: b64 });
        if (budget <= 0) {
          pagesOut.push({ page: i + 1, note: "truncated (byte budget)" });
          break;
        }
      }
      return {
        path: payload.path, mode: "images", page_count: total,
        pages: pagesOut, rendered: pagesOut.length,
        note: "each page is a PNG data URL — decode png_b64 and show to the vision model, or upload to the chat",
      };
    }
    const pagesOut = [];
    let charBudget = MAX_READ;
    for (const i of wanted) {
      const txt = doc.getPage(i).getText().trim();
      pagesOut.push({ page: i + 1, text: txt });
      charBudget -= txt.length;
      if (charBudget <= 0) {
        pagesOut.push({ page: i + 1, text: "…truncated (budget)" });
        break;
      }
    }
    return { path: payload.path, page_count: total, pages: pagesOut };
  } finally {
    doc.destroy();
  }
}

/* ---------------- /pdf_op split|merge|rotate (pdf-lib writer) ---------------- */

async function opPdfOp(payload) {
  const op = String(payload.op || "");
  if (!["split", "merge", "rotate"].includes(op)) throw engError(400, "op must be split|merge|rotate");
  const files = payload.__files || [];
  if (!files.length || files.length > PDF_OP_MAX_INPUTS) throw engError(400, "paths must be a 1-20 list");
  if (op !== "merge" && files.length > 1) throw engError(400, op + " takes exactly one input");
  const outRel = String(payload.out || "");
  if (!outRel || !outRel.toLowerCase().endsWith(".pdf")) throw engError(400, "need out (root-relative .pdf)");
  const angle = ((clampInt(payload.angle, 0, 359, 90) % 360) + 360) % 360;
  const L = await loadPdfLibGlobal();
  const srcs = [];
  for (const f of files) {
    if (extOfName(f.name) !== ".pdf") throw engError(400, "input must be .pdf, not " + extOfName(f.name));
    srcs.push(await L.PDFDocument.load(b64ToBytes(f.b64), { ignoreEncryption: true }));
  }

  if (op === "split") {
    const total = srcs[0].getPageCount();
    const wanted = parsePagesParam(String(payload.pages || ""), total);
    if (!wanted.length) throw engError(400, "no pages selected (doc has " + total + ")");
    const base = outRel.replace(/\.pdf$/i, "");
    const writes = [];
    for (const i of wanted) {
      const nd = await L.PDFDocument.create();
      const cp = await nd.copyPages(srcs[0], [i]);
      nd.addPage(cp[0]);
      const data = await nd.save();
      if (data.length > MAX_BINARY) throw engError(413, "split output too large (> " + MAX_BINARY + " bytes)");
      writes.push({ rel: base + ".p" + (i + 1) + ".pdf", b64: bytesToB64(data) });
    }
    return {
      __writeFiles: writes,
      ok: true, pages_split: writes.length,
      files: writes.map((w) => ({ file: w.rel.split("/").pop(), bytes: atob(w.b64).length })),
      note: "one PDF per selected page: <out-base>.pN.pdf",
    };
  }
  if (op === "merge") {
    const merged = await L.PDFDocument.create();
    const pagesInfo = [];
    for (let s = 0; s < srcs.length; s++) {
      const cps = await merged.copyPages(srcs[s], srcs[s].getPageIndices());
      for (const cp of cps) merged.addPage(cp);
      pagesInfo.push({ file: files[s].name, pages: srcs[s].getPageCount() });
    }
    const data = await merged.save();
    if (data.length > MAX_BINARY) throw engError(413, "merged PDF too large (> " + MAX_BINARY + " bytes)");
    return {
      __writeFile: { rel: outRel, b64: bytesToB64(data) },
      ok: true, written: "/" + outRel.replace(/^\/+/, ""), bytes: data.length,
      pages: merged.getPageCount(), sources: pagesInfo,
    };
  }
  // rotate
  const total = srcs[0].getPageCount();
  const wanted = parsePagesParam(String(payload.pages || ""), total);
  if (!wanted.length) throw engError(400, "no pages selected (doc has " + total + ")");
  if (angle === 0) throw engError(400, "angle 0 does nothing");
  for (const i of wanted) {
    const p = srcs[0].getPage(i);
    p.setRotation(L.degrees((p.getRotation().angle + angle) % 360));
  }
  const data = await srcs[0].save();
  if (data.length > MAX_BINARY) throw engError(413, "rotated PDF too large (> " + MAX_BINARY + " bytes)");
  return {
    __writeFile: { rel: outRel, b64: bytesToB64(data) },
    ok: true, written: "/" + outRel.replace(/^\/+/, ""), bytes: data.length,
    pages_rotated: wanted.length, angle: angle,
  };
}

/* ---------------- small helpers ---------------- */

function engError(status, msg) {
  const e = new Error(msg);
  e.statusCode = status;
  return e;
}
function head5(u8) {
  let s = "";
  for (let i = 0; i < Math.min(5, u8.length); i++) s += String.fromCharCode(u8[i]);
  return s;
}
function extOfName(name) {
  const m = String(name).match(/(\.[^.]+)$/);
  return m ? m[1].toLowerCase() : "";
}
function mimeFor(ext) {
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".bmp") return "image/bmp";
  if (ext === ".tif" || ext === ".tiff") return "image/tiff";
  return "image/png";
}
function isImageExt(ext) {
  return [".png", ".jpg", ".jpeg", ".bmp", ".webp", ".tif", ".tiff"].includes(ext);
}
function clampInt(v, lo, hi, dflt) {
  const n = parseInt(v, 10);
  if (isNaN(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}
function parsePagesParam(spec, total) {
  if (!spec) return listRange(total);
  const out = [];
  for (let part of String(spec).split(",")) {
    part = part.trim();
    if (!part) continue;
    if (part.includes("-")) {
      const [a, b] = part.split("-", 2);
      for (let i = parseInt(a, 10); i <= Math.min(parseInt(b, 10), total); i++) out.push(i - 1);
    } else {
      out.push(parseInt(part, 10) - 1);
    }
  }
  return [...new Set(out)].filter((i) => i >= 0 && i < total).sort((a, b) => a - b);
}
function listRange(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(i);
  return out;
}
function bytesToB64(u8) {
  let s = "";
  const CH = 32768;
  for (let i = 0; i < u8.length; i += CH)
    s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  return btoa(s);
}

/* ---------------- registration ---------------- */

Object.assign(ENGINE_HANDLERS, {
  "engine.init": async () => {
    await loadPdfLibGlobal();
    return { pdf: true, ocr: true, langs: ENG_OCR_LANGS };
  },
  "pdf.text": opPdfText,
  "pdf.op": opPdfOp,
  "ocr": opOcr,
  "ocr.pdf": opOcrPdf,
});
