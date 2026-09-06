// Open File Bridge — engine bridge (P3/P4 placeholder).
//
// tesseract.js + pdfium-WASM run in the extension PAGE (plan §4.2);
// the SW stays a thin router. Until those phases land, engine endpoints
// answer with an honest 501 "engine not bundled yet".

"use strict";

const FS_ENGINES = { pdf: false, ocr: false };
const FS_OCR_LANGS = [];

async function fsEngineRoute(method, path, q, body) {
  return fsFail(501, {
    error: path + " engine not bundled in this build",
    hint: "pdfium-WASM and tesseract.js land in Stage-3 phases P3/P4",
  });
}

/* ---- zip helpers (fflate runs in the page; SW fallback = store-only) --- */

async function fsZipBytes(items) {
  // items: [{name, file}] — needs a real deflate implementation.
  // Vendor fflate in P2b; for now build a STORE-method zip (correct,
  // readable by every unzipper, just uncompressed).
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
  // find EOCD
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
  throw new Error("deflate members need the fflate engine (P2b)");
}
