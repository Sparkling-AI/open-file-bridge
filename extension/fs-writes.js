// Open File Bridge — FS adapter writes (Stage 3).
//
// Write family with the app-v2.11 contract: writes immediate, snapshot-
// first, no approval round-trip; rate breaker; trash-deletes; chunked
// transfers with IndexedDB records so MV3 SW death mid-write is safe.

"use strict";

/* ---------------- plain writes ---------------- */

async function epWrite(body, isB64) {
  const rg = await resolveGuarded(unquoteComp(body.path || ""), { forWrite: true });
  let bytes;
  if (isB64) {
    try { bytes = b64dec(body.b64); }
    catch (e) { return fsFail(400, { error: "invalid base64: " + e }); }
    if (bytes.length > MAX_BINARY) {
      return fsFail(413, { error: "payload too large: " + bytes.length + " > " + MAX_BINARY + " bytes" });
    }
  } else {
    const text = String(body.content ?? "");
    bytes = new TextEncoder().encode(text);
  }
  const rr = await rateCheck(bytes.length);
  if (!rr.ok) return fsFail(429, { error: rr.err, rate_limited: true, hint: "relay this to the user and wait for their confirmation" });
  const snap = await snapshotBeforeWrite(rg.rootRec, rg.parts);
  if (bytes.length > CHUNK) {
    // chunked transfer (plan §4.1) — same response shape on success
    const res = await chunkedWrite(rg.rootRec, rg.parts, bytes);
    await auditRow({ endpoint: isB64 ? "/write_b64" : "/write", method: "POST", path: rg.relInRoot, size: bytes.length, status: 200 });
    return fsOk(Object.assign(res, { snapshot: snap }));
  }
  await writeFileBytes(rg.rootRec, rg.parts, bytes);
  await auditRow({ endpoint: isB64 ? "/write_b64" : "/write", method: "POST", path: rg.relInRoot, size: bytes.length, status: 200 });
  return fsOk({ ok: true, written: writtenPathFor(rg), bytes: bytes.length, snapshot: snap });
}

function writtenPathFor(rg) {
  return "/" + rg.relInRoot;
}

/* ---------------- chunked transfer protocol ---------------- */

/** >1MB writes: parts land in .ofb-chunks/<tid>/, transfer record in
 * IndexedDB; finalize = concat onto temp, move onto target. If the SW
 * dies mid-chunk the record survives; the NEXT message with the same tid
 * + seq resumes without re-sending earlier chunks. */
async function chunkedWrite(rootRec, parts, bytes) {
  // resume-aware: reuse an OPEN record for the same root+path (a prior
  // attempt may have died mid-chunk when the SW was reclaimed)
  let tid = null;
  let rec = null;
  try {
    const open = (await OFBIDB.all("transfers")) || [];
    const cand = open.find((r) => r.status === "open" && r.rootId === rootRec.id &&
      r.relPath === parts.join("/") && r.total === bytes.length);
    if (cand) { tid = cand.tid; rec = cand; }
  } catch (e) { /* fresh transfer */ }
  if (!rec) {
    tid = "t" + hexRand(8);
    rec = {
      tid: tid, rootId: rootRec.id, relPath: parts.join("/"),
      total: bytes.length, received: 0, ts: Date.now(), status: "open",
    };
    await OFBIDB.put("transfers", rec);
  }
  await writeChunkParts(rootRec, tid, bytes, 0);
  await finalizeTransfer(rootRec, parts, rec, tid);
  return { ok: true, written: "/" + parts.join("/"), bytes: bytes.length, chunked: true, tid: tid };
}

async function writeChunkParts(rootRec, tid, bytes, startPartIdx) {
  let dir = rootRec.handle;
  for (const seg of [CHUNKS_DIR, tid]) {
    dir = await dir.getDirectoryHandle(seg, { create: true });
  }
  for (let i = startPartIdx; i * CHUNK < bytes.length; i++) {
    const slice = bytes.subarray(i * CHUNK, Math.min((i + 1) * CHUNK, bytes.length));
    const part = await dir.getFileHandle("p" + i + ".part", { create: true });
    await bytesToFileHandle(slice, part);
  }
  return dir;
}

async function finalizeTransfer(rootRec, parts, rec, tid) {
  // concatenate parts → temp in target dir → overwrite target.
  // Parts are VALIDATED first: a part file left partial by an SW death
  // must not silently corrupt the target (resume = resend that seq).
  let chunksDir = rootRec.handle;
  for (const seg of [CHUNKS_DIR, tid]) {
    chunksDir = await chunksDir.getDirectoryHandle(seg);
  }
  const nParts = Math.ceil(rec.total / CHUNK);
  for (let i = 0; i < nParts; i++) {
    let size = -1;
    try { size = (await (await chunksDir.getFileHandle("p" + i + ".part")).getFile()).size; }
    catch (e) { /* missing */ }
    const want = (i === nParts - 1) ? rec.total - (nParts - 1) * CHUNK : CHUNK;
    if (size !== want) {
      throw new OpFail(409, {
        error: "transfer incomplete: chunk " + i + " is " + size + "B, expected " + want +
          "B — resend from seq " + i,
        tid: tid, resume_seq: i,
      });
    }
  }
  const parent = await walkToParent(rootRec, parts, true);
  const tmpName = ".ofb-tmp-" + hexRand(4) + "-" + parent.fileName;
  const tmp = await parent.dir.getFileHandle(tmpName, { create: true });
  const tw = await tmp.createWritable();
  for (let i = 0; i < nParts; i++) {
    const pf = await chunksDir.getFileHandle("p" + i + ".part");
    const buf = new Uint8Array(await (await pf.getFile()).arrayBuffer());
    await tw.write(buf);
  }
  await tw.close();
  const target = await parent.dir.getFileHandle(parent.fileName, { create: true });
  await copyFileToFile(await tmp.getFile(), target);
  await removeQuiet(parent.dir, tmpName);
  // cleanup chunk dir + mark record done
  let chunksRoot = rootRec.handle;
  chunksRoot = await chunksRoot.getDirectoryHandle(CHUNKS_DIR);
  await removeQuiet(chunksRoot, tid);
  rec.status = "done";
  await OFBIDB.put("transfers", rec);
  return parent.fileName;
}

/* ---------------- /write_b64_chunk (manual chunk API) ---------------- */

/** Multi-message chunked write for model-driven large payloads:
 *  {tid?, path, seq, total, b64, last?} — tid reused across messages;
 *  seq is the 0-based chunk index. Returns progress; on last, finalizes. */
async function epWriteB64Chunk(body) {
  const rg = await resolveGuarded(unquoteComp(body.path || ""), { forWrite: true });
  if (typeof body.seq !== "number" || typeof body.total !== "number") {
    return fsFail(400, { error: "missing seq/total" });
  }
  let bytes;
  try { bytes = b64dec(body.b64); }
  catch (e) { return fsFail(400, { error: "invalid base64: " + e }); }
  if (bytes.length > CHUNK) {
    return fsFail(413, { error: "chunk exceeds " + CHUNK + " bytes" });
  }
  let tid = body.tid;
  let rec = null;
  if (tid) {
    rec = await OFBIDB.get("transfers", tid);
  }
  if (!rec) {
    tid = "t" + hexRand(8);
    rec = { tid: tid, rootId: rg.rootRec.id, relPath: rg.parts.join("/"),
      total: body.total, received: 0, ts: Date.now(), status: "open" };
    await OFBIDB.put("transfers", rec);
  }
  if (rec.relPath !== rg.parts.join("/") || rec.rootId !== rg.rootRec.id) {
    return fsFail(400, { error: "tid belongs to a different transfer" });
  }
  // idempotent resume: seq indexes the chunk stream; rewrite is safe
  let dir = rg.rootRec.handle;
  for (const seg of [CHUNKS_DIR, tid]) {
    dir = await dir.getDirectoryHandle(seg, { create: true });
  }
  const part = await dir.getFileHandle("p" + body.seq + ".part", { create: true });
  await bytesToFileHandle(bytes, part);
  rec.received = Math.min(rec.received, body.seq * CHUNK) + bytes.length;
  rec.lastSeq = body.seq;
  await OFBIDB.put("transfers", rec);
  if (body.last) {
    // confirmation gate (fs-confirm): finalize OVERWRITES the target —
    // a fresh-tid chunk stream can arrive here without an initiating
    // gated /write_b64, so check here too (the model-facing ask is the
    // same single popup; grants are path-keyed, not endpoint-keyed)
    const gate = await confirmGate("POST", "/write_b64_chunk",
      JSON.stringify({ path: rg.relInRoot, __finalizing: true }), null);
    if (gate) {
      return fsFail(403, Object.assign(gate, {
        note: "chunked finalize gated — approve and resend the last chunk",
      }));
    }
    const rc = await rateCheck(rec.received);
    if (!rc.ok) return fsFail(429, { error: rc.err, rate_limited: true });
    const snap = await snapshotBeforeWrite(rg.rootRec, rg.parts);
    await finalizeTransfer(rg.rootRec, rg.parts, rec, tid);
    await auditRow({ endpoint: "/write_b64_chunk", method: "POST", path: rg.relInRoot, size: rec.received, status: 200 });
    return fsOk({ ok: true, written: "/" + rg.relInRoot, bytes: rec.received, tid: tid, snapshot: snap, last: true });
  }
  return fsOk({ ok: true, tid: tid, received: rec.received, total: body.total, last: false });
}

/* ---------------- /write_many ---------------- */

const MAX_WRITE_MANY = 100;

async function epWriteMany(body) {
  const writes = Array.isArray(body.writes) ? body.writes : [];
  if (!writes.length) return fsFail(400, { error: "missing writes[]" });
  if (writes.length > MAX_WRITE_MANY) {
    return fsFail(400, { error: "too many writes: " + writes.length + " > " + MAX_WRITE_MANY });
  }
  const results = [];
  for (const w of writes) {
    if (!w || typeof w !== "object" || !w.path) {
      results.push({ path: w && w.path, status: 400, error: "bad write spec" });
      continue;
    }
    const one = await fsRoute("POST", "/write", JSON.stringify(w));
    const parsed = safeParse(one.body);
    results.push({ path: w.path, status: one.status, body: parsed });
  }
  const okAll = results.every((r) => r.status === 200);
  await auditRow({ endpoint: "/write_many", method: "POST", path: "(" + writes.length + " writes)", size: results.length, status: okAll ? 200 : 400 });
  return fsOk({ ok: okAll, results: results });
}

function safeParse(s) {
  try { return JSON.parse(s); } catch (e) { return { error: String(s).slice(0, 200) }; }
}

/* ---------------- /edit ---------------- */

async function epEdit(body) {
  const rg = await resolveGuarded(unquoteComp(body.path || ""));
  const file = await getFileFor(rg.rootRec, rg.parts);
  const text = await file.text();
  const edits = Array.isArray(body.edits) ? body.edits : [];
  const dryRun = body.dry_run === true;
  const results = [];
  let changed = false;
  let newText = text;
  for (const e of edits) {
    const from = String(e && e.from || "");
    const to = String((e && e.to) ?? "");
    if (!from) { results.push({ ok: false, error: "missing from" }); continue; }
    const count = newText.split(from).length - 1;
    if (count === 0) { results.push({ ok: false, error: "not found: " + from.slice(0, 60) }); continue; }
    if (dryRun) { results.push({ ok: true, would_replace: count }); continue; }
    newText = newText.split(from).join(to);
    changed = true;
    results.push({ ok: true, replaced: count });
  }
  if (dryRun) {
    return fsOk({ ok: true, dry_run: true, results: results });
  }
  if (!changed) {
    return fsOk({ ok: false, results: results });
  }
  const rc = await rateCheck(newText.length);
  if (!rc.ok) return fsFail(429, { error: rc.err, rate_limited: true });
  const snap = await snapshotBeforeWrite(rg.rootRec, rg.parts);
  await writeFileBytes(rg.rootRec, rg.parts, new TextEncoder().encode(newText));
  await auditRow({ endpoint: "/edit", method: "JS-POST".slice(3), path: rg.relInRoot, size: newText.length, status: 200 });
  return fsOk({ ok: true, results: results, snapshot: snap });
}

/* ---------------- /delete (trash-move) ---------------- */

async function epDelete(body) {
  const rg = await resolveGuarded(unquoteComp(body.path || ""), { forWrite: true });
  const w = await walkToParent(rg.rootRec, rg.parts, false);
  if (!w) return fsFail(404, { error: "no such file: " + body.path });
  const rc = await rateCheck(0);
  if (!rc.ok) return fsFail(429, { error: rc.err, rate_limited: true });
  let file = null;
  try {
    const fh = await w.dir.getFileHandle(w.fileName);
    file = await fh.getFile();
  } catch (e) { /* maybe dir */ }
  const ts = tsStamp();
  if (file) {
    let tdir = rg.rootRec.handle;
    for (const seg of [TRASH_DIR, ts].concat(rg.parts.slice(0, -1))) {
      tdir = await tdir.getDirectoryHandle(seg, { create: true });
    }
    const dst = await tdir.getFileHandle(w.fileName, { create: true });
    await copyFileToFile(file, dst);
    await w.dir.removeEntry(w.fileName);
    await auditRow({ endpoint: "/delete", method: "POST", path: rg.relInRoot, size: file.size, status: 200 });
    return fsOk({ ok: true, deleted: rg.relInRoot, trash: TRASH_DIR + "/" + ts + "/", size: file.size });
  }
  // directory: move the subtree
  try {
    await w.dir.getDirectoryHandle(w.fileName);
  } catch (e) {
    return fsFail(404, { error: "no such file: " + body.path });
  }
  await moveDirToTrash(rg.rootRec, rg.parts, ts);
  await auditRow({ endpoint: "/delete", method: "POST", path: rg.relInRoot, status: 200 });
  return fsOk({ ok: true, deleted: rg.relInRoot, trash: TRASH_DIR + "/" + ts + "/" });
}

async function moveDirToTrash(rootRec, parts, ts) {
  let srcParent = rootRec.handle;
  for (const seg of parts.slice(0, -1)) {
    srcParent = await srcParent.getDirectoryHandle(seg);
  }
  const srcDirHandle = await srcParent.getDirectoryHandle(parts[parts.length - 1]);
  // trash/<ts>/<nested path…>/<name>
  let tcur = await trashRootFor(rootRec, ts);
  for (const seg of parts.slice(0, -1)) {
    tcur = await tcur.getDirectoryHandle(seg, { create: true });
  }
  await copyDirRecursive(srcDirHandle, tcur, parts[parts.length - 1]);
  await srcParent.removeEntry(parts[parts.length - 1], { recursive: true });
}

async function trashRootFor(rootRec, ts) {
  const d = await rootRec.handle.getDirectoryHandle(TRASH_DIR, { create: true });
  return await d.getDirectoryHandle(ts, { create: true });
}

async function copyDirRecursive(srcDirHandle, dstParentHandle, name) {
  const dst = await dstParentHandle.getDirectoryHandle(name, { create: true });
  for await (const [nm, h] of srcDirHandle.entries()) {
    if (h.kind === "file") {
      const f = await h.getFile();
      const dstf = await dst.getFileHandle(nm, { create: true });
      await copyFileToFile(f, dstf);
    } else {
      await copyDirRecursive(h, dst, nm);
    }
  }
  return dst;
}

/* ---------------- /versions + /trash lists + restore ---------------- */

async function epVersionsList(body) {
  const rel = unquoteComp(body.path || "") || "";
  const roots = await enabledRoots();
  if (!roots.length) throw new OpFail(503, { error: "no shared folder configured" });
  let rootRec = roots[0], targetRel = null;
  if (rel && rel !== ".") {
    const rg = await resolveGuarded(rel);
    rootRec = rg.rootRec;
    targetRel = rg.relInRoot;
  }
  const snaps = await listSnapshotDirs(rootRec, SNAP_DIR, targetRel);
  await auditRow({ endpoint: "/versions/list", method: "POST", path: rel || ".", status: 200 });
  return fsOk({ versions: snaps });
}

async function epTrashList(body) {
  const rel = unquoteComp(body.path || "") || "";
  const roots = await enabledRoots();
  if (!roots.length) throw new OpFail(503, { error: "no shared folder configured" });
  let rootRec = roots[0], targetRel = null;
  if (rel && rel !== ".") {
    const rg = await resolveGuarded(rel);
    rootRec = rg.rootRec;
    targetRel = rg.relInRoot;
  }
  const items = await listSnapshotDirs(rootRec, TRASH_DIR, targetRel);
  return fsOk({ items: items });
}

/** Read a snapshot WITHOUT restoring it (Dandan 2026-09-09: the model
 * restored a version just to READ it — reading must never touch the live
 * file or ask for approval). ts is validated against the snapshot-stamp
 * shape; the snapshot tree is ignore-listed, so handles are walked
 * directly, exactly like epRestore. */
async function epVersionsRead(body) {
  const rel = unquoteComp(body.path || "");
  const ts = String(body.ts || "");
  if (!rel || !ts) return fsFail(400, { error: "missing path/ts" });
  if (!/^\d{8}-\d{6}-[0-9a-f]{2}$/.test(ts)) {
    return fsFail(400, { error: "bad ts — use one from /versions/list" });
  }
  const rg = await resolveGuarded(rel);
  let fh;
  try {
    let src = rg.rootRec.handle;
    for (const seg of [SNAP_DIR, ts].concat(rg.parts.slice(0, -1))) {
      src = await src.getDirectoryHandle(seg);
    }
    fh = await src.getFileHandle(rg.parts[rg.parts.length - 1]);
  } catch (e) {
    return fsFail(404, { error: "no version entry: " + ts + " for " + rel });
  }
  const file = await fh.getFile();
  if (body.b64 === true) {
    if (file.size > MAX_BINARY) {
      return fsFail(413, { error: "version too large: " + file.size + " > " + MAX_BINARY });
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    await auditRow({ endpoint: "/versions/read", method: "POST", path: rg.relInRoot, status: 200, size: bytes.length });
    return fsOk({ path: rg.relInRoot, ts: ts, size: file.size, b64: b64enc(bytes) });
  }
  // text mode: byte-cap then decode (approximation like /read — multibyte
  // tails may cut; truncated flags it)
  const cap = MAX_READ * 4;
  const sliced = file.size > cap ? await file.slice(0, cap).arrayBuffer() : await file.arrayBuffer();
  const content = new TextDecoder("utf-8", { fatal: false })
    .decode(new Uint8Array(sliced)).slice(0, MAX_READ);
  await auditRow({ endpoint: "/versions/read", method: "POST", path: rg.relInRoot, status: 200, size: file.size });
  return fsOk({ path: rg.relInRoot, ts: ts, size: file.size, content: content,
    truncated: file.size > cap || undefined });
}

async function epRestore(kind, body) {
  const rel = unquoteComp(body.path || "");
  const ts = String(body.ts || "");
  if (!rel || !ts) return fsFail(400, { error: "missing path/ts" });
  const rg = await resolveGuarded(rel, { forWrite: true });
  const srcDirName = kind === "versions" ? SNAP_DIR : TRASH_DIR;
  let srcFileHandle;
  try {
    let src = rg.rootRec.handle;
    for (const seg of [srcDirName, ts].concat(rg.parts.slice(0, -1))) {
      src = await src.getDirectoryHandle(seg);
    }
    srcFileHandle = await src.getFileHandle(rg.parts[rg.parts.length - 1]);
  } catch (e) {
    return fsFail(404, { error: "no " + kind + " entry: " + ts + " for " + rel });
  }
  const rc = await rateCheck(0);
  if (!rc.ok) return fsFail(429, { error: rc.err, rate_limited: true });
  const snap = await snapshotBeforeWrite(rg.rootRec, rg.parts); // snapshot-on-restore
  const file = await srcFileHandle.getFile();
  await writeFileBytes(rg.rootRec, rg.parts, new Uint8Array(await file.arrayBuffer()));
  await auditRow({ endpoint: "/" + kind + "/restore", method: "POST", path: rg.relInRoot, status: 200, size: file.size });
  return fsOk({ ok: true, restored: rg.relInRoot, from: kind + "/" + ts, snapshot: snap });
}

/* ---------------- /zip + /unzip ---------------- */

const ZIP_CAP_BYTES = 8000000;
const ZIP_CAP_MEMBERS = 200;
const UNZIP_CAP_ENTRIES = 1000;

async function epZip(body) {
  const members = Array.isArray(body.members) ? body.members : [];
  const outName = String(body.out || "");
  if (!members.length || !outName) return fsFail(400, { error: "missing members[]/out" });
  if (members.length > ZIP_CAP_MEMBERS) return fsFail(400, { error: "too many members: >" + ZIP_CAP_MEMBERS });
  if (!outName.endsWith(".zip")) return fsFail(400, { error: "out must end .zip" });
  const roots = await enabledRoots();
  if (!roots.length) throw new OpFail(503, { error: "no shared folder configured" });
  // resolve members (validate + sensitive/ignore floor per member)
  const files = [];
  let total = 0;
  for (const m of members) {
    const rg = await resolveGuarded(unquoteComp(String(m)), {});
    const f = await getFileFor(rg.rootRec, rg.parts);
    if (f.size > MAX_BINARY) throw new OpFail(413, { error: "member too large: " + m });
    total += f.size;
    files.push({ name: rg.parts[rg.parts.length - 1], file: f });
  }
  if (total > ZIP_CAP_BYTES) return fsFail(413, { error: "zip payload too large: " + total });
  const rc = await rateCheck(total);
  if (!rc.ok) return fsFail(429, { error: rc.err, rate_limited: true });
  // build the zip via the engine page (it has fflate) or inline fallback
  const zipped = await fsZipBytes(files.map((x) => ({ name: x.name, bytes: new Uint8Array(0), file: x.file })));
  const rgOut = await resolveGuarded(unquoteComp(outName), { forWrite: true });
  const snap = await snapshotBeforeWrite(rgOut.rootRec, rgOut.parts);
  await writeFileBytes(rgOut.rootRec, rgOut.parts, zipped);
  await auditRow({ endpoint: "/zip", method: "POST", path: rgOut.relInRoot, size: zipped.length, status: 200 });
  return fsOk({ ok: true, written: "/" + rgOut.relInRoot, bytes: zipped.length, members: members.length, snapshot: snap });
}

async function epUnzip(body) {
  const path = unquoteComp(body.path || "");
  const dest = unquoteComp(body.dest || "") || "";
  if (!path) return fsFail(400, { error: "missing path" });
  const rg = await resolveGuarded(path, {});
  const file = await getFileFor(rg.rootRec, rg.parts);
  if (file.size > ZIP_CAP_BYTES) return fsFail(413, { error: "archive too large: " + file.size });
  const entries = await fsUnzipList(new Uint8Array(await file.arrayBuffer()));
  if (entries.length > UNZIP_CAP_ENTRIES) return fsFail(400, { error: "too many entries: >" + UNZIP_CAP_ENTRIES });
  // zip-slip guard (app parity): REJECT absolute / drive-letter / '..'
  for (const e of entries) {
    const nm = e.name;
    if (nm.startsWith("/") || /^([A-Za-z]:)/.test(nm) || nm.split("/").includes("..")) {
      return fsFail(400, { error: "zip-slip refused: unsafe member '" + nm + "'" });
    }
  }
  const rc = await rateCheck(file.size);
  if (!rc.ok) return fsFail(429, { error: rc.err, rate_limited: true });
  const destParts = dest ? dest.split("/").filter(Boolean) : [];
  let count = 0, total = 0;
  for (const e of entries) {
    const targetParts = destParts.concat(e.name.split("/").filter(Boolean));
    if (sensitiveName(targetParts[targetParts.length - 1])) continue;
    if (e.dir) {
      let d = rg.rootRec.handle;
      for (const seg of targetParts) d = await d.getDirectoryHandle(seg, { create: true });
      continue;
    }
    const data = await fsUnzipEntry(new Uint8Array(await file.arrayBuffer()), e.name);
    await writeFileBytes(rg.rootRec, targetParts, data);
    count++;
    total += data.length;
  }
  await auditRow({ endpoint: "/unzip", method: "POST", path: rg.relInRoot, size: total, status: 200 });
  return fsOk({ ok: true, extracted: count, bytes: total, dest: dest || "." });
}
