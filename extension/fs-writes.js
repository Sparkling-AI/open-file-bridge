// Open File Bridge — FS adapter writes (Stage 3).
//
// Write family with the app-v2.11 contract: writes immediate, snapshot-
// first, no approval round-trip; rate breaker; trash-deletes; chunked
// transfers with IndexedDB records so MV3 SW death mid-write is safe.

"use strict";

/* ---------------- plain writes ---------------- */

/** Pilot items 7+10: the write answer's path fields must round-trip.
 * written = the path WITHOUT a leading / (models used to feed "/x" back
 * and older bridges rejected it); with several roots shared it KEEPS the
 * root id prefix so it lands in the same folder. root_id is always
 * present; root_name is the display alias for answers. */
function writtenFields(rg) {
  return {
    written: (rootsCountCached > 1 ? rg.rootRec.id + "/" : "") + rg.relInRoot,
    root_id: rg.rootRec.id,
    root_name: rg.rootRec.alias || rg.rootRec.id,
  };
}

// refreshed before each write answer (cheap; avoids re-querying IDB per field)
let rootsCountCached = 1;
async function refreshRootsCount() {
  try { rootsCountCached = (await enabledRoots()).length; } catch (e) { rootsCountCached = 1; }
}

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
  if (!rr.ok) return fsFail(429, { error: rr.err, rate_limited: true, retry_after_s: 60, hint: "relay this to the user and wait for their confirmation; for content questions prefer /search over listing many files" });
  const snap = await snapshotBeforeWrite(rg.rootRec, rg.parts);
  await refreshRootsCount();
  const wf = writtenFields(rg);
  const extra = (rg.ambiguous ? { root_note: "several folders are shared — this path resolved to '" +
    (rg.rootRec.alias || rg.rootRec.id) + "'. Prefix future paths with a root id." } : {});
  if (bytes.length > CHUNK) {
    // chunked transfer (plan §4.1) — same response shape on success
    const res = await chunkedWrite(rg.rootRec, rg.parts, bytes);
    await auditRow({ endpoint: isB64 ? "/write_b64" : "/write", method: "POST", path: rg.relInRoot, size: bytes.length, status: 200 });
    return fsOk(Object.assign(res, { snapshot: snap }, wf, extra));
  }
  await writeFileBytes(rg.rootRec, rg.parts, bytes);
  await auditRow({ endpoint: isB64 ? "/write_b64" : "/write", method: "POST", path: rg.relInRoot, size: bytes.length, status: 200 });
  return fsOk(Object.assign({ ok: true, bytes: bytes.length, snapshot: snap }, wf, extra));
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
  return { ok: true, written: (rootsCountCached > 1 ? rootRec.id + "/" : "") + parts.join("/"),
    root_id: rootRec.id, root_name: rootRec.alias || rootRec.id,
    bytes: bytes.length, chunked: true, tid: tid };
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
async function epWriteB64Chunk(body, ctx) {
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
      JSON.stringify({ path: rg.relInRoot, __finalizing: true }),
      (ctx && ctx.tabId != null) ? ctx.tabId : null);
    if (gate) {
      return fsFail(403, Object.assign(gate, {
        note: "chunked finalize gated — approve and resend the last chunk",
      }));
    }
    const rc = await rateCheck(rec.received);
    if (!rc.ok) return fsFail(429, { error: rc.err, rate_limited: true, retry_after_s: 60 });
    const snap = await snapshotBeforeWrite(rg.rootRec, rg.parts);
    await finalizeTransfer(rg.rootRec, rg.parts, rec, tid);
    await auditRow({ endpoint: "/write_b64_chunk", method: "POST", path: rg.relInRoot, size: rec.received, status: 200 });
    return fsOk(Object.assign({ ok: true, bytes: rec.received, tid: tid, snapshot: snap, last: true }, writtenFields(rg)));
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
  if (!rc.ok) return fsFail(429, { error: rc.err, rate_limited: true, retry_after_s: 60 });
  const snap = await snapshotBeforeWrite(rg.rootRec, rg.parts);
  await writeFileBytes(rg.rootRec, rg.parts, new TextEncoder().encode(newText));
  await auditRow({ endpoint: "/edit", method: "JS-POST".slice(3), path: rg.relInRoot, size: newText.length, status: 200 });
  // edited+path: the app's _attach_links key — the router mints outcome
  // links from exactly these two fields
  const edited = results.reduce((n, r) => n + (r.ok ? (r.replaced || 0) : 0), 0);
  return fsOk(Object.assign({ ok: true, edited: edited, path: await echoPath(rg),
    results: results, snapshot: snap }, writtenFields(rg)));
}

/* ---------------- /delete (trash-move) ---------------- */

async function epDelete(body, opts) {
  const internal = opts && opts.internal; // batch inner op: the ONE card
  // already confirmed this whole mass edit — the per-op rate breaker
  // would otherwise abort a 30-file batch at item 21
  if (Array.isArray(body.paths) && body.paths.length) {
    // 3.7.0 (tester blocker 5): refuse oversized batches UP FRONT —
    // the old silent slice(0, 50) did 50 of 55 and answered
    // ok:true deleted:50 failed:0, leaving 5 files behind.
    if (body.paths.length > 50) {
      return fsFail(400, {
        error: "batch too large: " + body.paths.length + " paths (max 50)",
        hint: "split into chunks of ≤ 50 and run them as separate calls, " +
          "or list a folder instead of deleting files one by one",
      });
    }
    const results = [];
    let fails = 0;
    for (const p of body.paths.slice(0, 50)) {
      const one = await epDelete({ path: String(p || "") }, { internal: true });
      if (one.status !== 200) fails++;
      let ob = null;
      try { ob = JSON.parse(one.body || "{}"); } catch (e) {}
      results.push({ path: String(p || ""), ok: one.status === 200,
        error: one.status === 200 ? undefined : (ob && ob.error) || ("HTTP " + one.status) });
    }
    await auditRow({ endpoint: "/delete", method: "POST", path: "(batch " + results.length + ")", status: fails ? 207 : 200 });
    const out = { ok: fails === 0, deleted: results.filter((r) => r.ok).length,
      failed: fails, results: results };
    if (fails) out.hint = "some paths failed — see results[]; every failure is listed with its reason";
    return fails ? fsFail(207, out) : fsOk(out);
  }
  const rg = await resolveGuarded(unquoteComp(body.path || ""), { forWrite: true });
  const w = await walkToParent(rg.rootRec, rg.parts, false);
  if (!w) return fsFail(404, { error: "no such file: " + body.path });
  if (!internal) {
    const rc = await rateCheck(0);
    if (!rc.ok) return fsFail(429, { error: rc.err, rate_limited: true, retry_after_s: 60 });
  }
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
    return fsOk({ ok: true, deleted: rg.relInRoot, root_id: rg.rootRec.id, trash: TRASH_DIR + "/" + ts + "/", size: file.size });
  }
  // directory: move the subtree
  try {
    await w.dir.getDirectoryHandle(w.fileName);
  } catch (e) {
    return fsFail(404, { error: "no such file: " + body.path });
  }
  await moveDirToTrash(rg.rootRec, rg.parts, ts);
  await auditRow({ endpoint: "/delete", method: "POST", path: rg.relInRoot, status: 200 });
  return fsOk({ ok: true, deleted: rg.relInRoot, root_id: rg.rootRec.id, trash: TRASH_DIR + "/" + ts + "/" });
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

/* ---------------- /move + /mkdir (pilot item 15, 2026-10-23) --------
 * "Sort these 12 files into folders" was 12 copies + 12 deletes + 12
 * approval cards; parallel deletes each timed out separately and left
 * 9 duplicates behind (case E03). A native move is ONE confirmation
 * worded as a move (scope "destructive": the original disappears).
 * /mkdir exists because a folder could previously only be created by
 * writing a file into it. Both are snapshot-free: a move never
 * overwrites content (dest-exists is refused), and mkdir is pure
 * creation — undo = move back / delete the empty folder. */

async function epMove(body, opts) {
  const internal = opts && opts.internal; // batch inner op (see epDelete)
  const ctx = (opts && opts.ctx) || {};  // request-local {tabId} for the late gate
  // 3.5.0 (pilot item 15): batch move — one body, one approval card.
  if (Array.isArray(body.moves) && body.moves.length) {
    // 3.7.0 (tester blocker 5): same up-front cap as batch delete
    if (body.moves.length > 50) {
      return fsFail(400, {
        error: "batch too large: " + body.moves.length + " moves (max 50)",
        hint: "split into chunks of ≤ 50 and run them as separate calls",
      });
    }
    const results = [];
    let fails = 0;
    // 3.7.0 (tester should-fix): validate every source exists + every
    // destination free BEFORE the card — a batch the user approves must
    // be a batch that can actually run (partial 207s stay possible only
    // for races, e.g. a file appearing mid-batch)
    // 3.7.3 (review F4): this pre-check is READ-ONLY. It used to call
    // walkToParent(..., true), so a DENIED or timed-out batch left the
    // destination folders it invented on disk. Missing parents are now
    // created only after approval, inside the per-item epMove call.
    for (const m of body.moves) {
      if (!m || typeof m.from !== "string" || typeof m.to !== "string") continue;
      try {
        const rgF = await resolveGuarded(unquoteComp(m.from), { forWrite: true });
        const wF = await walkToParent(rgF.rootRec, rgF.parts, false);
        let ok = false;
        if (wF) {
          try { await wF.dir.getFileHandle(wF.fileName); ok = true; } catch (e) {}
          if (!ok) { try { await wF.dir.getDirectoryHandle(wF.fileName); ok = true; } catch (e) {} }
        }
        if (!ok) return fsFail(404, { error: "batch move: no such file: " + m.from,
          hint: "nothing was moved — fix the list and re-send" });
        const rgT = await resolveGuarded(unquoteComp(m.to), { forWrite: true });
        if (rgF.rootRec.id !== rgT.rootRec.id) {
          return fsFail(400, { error: "batch move: cannot move across shared folders (" +
            m.from + " → " + m.to + ")",
            hint: "nothing was moved — copy then delete instead" });
        }
        // destination parent may legitimately not exist yet (created after
        // approval) — then the destination cannot be occupied
        const wT = await walkToParent(rgT.rootRec, rgT.parts, false);
        let occupied = false;
        if (wT) {
          try { await wT.dir.getFileHandle(wT.fileName); occupied = true; } catch (e) {}
          if (!occupied) { try { await wT.dir.getDirectoryHandle(wT.fileName); occupied = true; } catch (e) {} }
        }
        if (occupied) return fsFail(409, { error: "batch move: destination exists: " + m.to,
          hint: "nothing was moved — move never overwrites; fix the list and re-send" });
      } catch (e) {
        return fsFail(400, { error: "batch move: " + String(e && e.message || e) });
      }
    }
    // ONE card for the whole (now pre-validated) batch
    const gate = await confirmGateLate("POST", "/move", body, ctx);
    if (gate) return fsFail(403, gate);
    for (const m of body.moves.slice(0, 50)) {
      if (!m || typeof m.from !== "string" || typeof m.to !== "string") {
        results.push({ from: m && m.from, ok: false, error: "each move needs {from, to}" });
        fails++;
        continue;
      }
      const one = await epMove({ from: m.from, to: m.to }, { internal: true, ctx: ctx });
      if (one.status !== 200) fails++;
      let ob = null;
      try { ob = JSON.parse(one.body || "{}"); } catch (e) {}
      results.push({ from: m.from, to: m.to, ok: one.status === 200,
        error: one.status === 200 ? undefined : (ob && ob.error) || ("HTTP " + one.status) });
    }
    await auditRow({ endpoint: "/move", method: "POST", path: "(batch " + results.length + ")", status: fails ? 207 : 200 });
    const out = { ok: fails === 0, moved: results.filter((r) => r.ok).length,
      failed: fails, results: results };
    if (fails) out.hint = "some moves failed — see results[]; failed originals are still in place";
    return fails ? fsFail(207, out) : fsOk(out);
  }
  const from = String(body.from || body.path || "").trim();
  const to = String(body.to || "").trim();
  if (!from || !to) {
    return fsFail(400, { error: "move needs {\"from\": …, \"to\": …}",
      hint: "moves or renames a file/folder inside the shared root(s); the destination must not exist" });
  }
  const rgF = await resolveGuarded(unquoteComp(from), { forWrite: true });
  const rgT = await resolveGuarded(unquoteComp(to), { forWrite: true });
  if (rgF.rootRec.id !== rgT.rootRec.id) {
    return fsFail(400, { error: "cannot move across shared folders (" +
      rgF.rootRec.id + " → " + rgT.rootRec.id + ")",
      hint: "copy then delete instead: write_binary(to, await read_binary(from)) then /delete" });
  }
  // moving a folder INTO ITSELF would recurse forever (a → a/b copies
  // a into a into a…) — refuse any destination inside the source
  if (rgT.relInRoot === rgF.relInRoot ||
      rgT.relInRoot.startsWith(rgF.relInRoot + "/")) {
    return fsFail(400, { error: "cannot move '" + from + "' into itself (" + to + ")",
      hint: "choose a destination outside the folder being moved" });
  }
  if (!internal) {
    const rc = await rateCheck(0);
    if (!rc.ok) return fsFail(429, { error: rc.err, rate_limited: true, retry_after_s: 60 });
  }
  // resolve source parent + entry kind
  const wF = await walkToParent(rgF.rootRec, rgF.parts, false);
  let srcFile = null, srcDir = null;
  try { const fh = await wF.dir.getFileHandle(wF.fileName); srcFile = await fh.getFile(); } catch (e) {}
  if (!srcFile) {
    try { srcDir = await wF.dir.getDirectoryHandle(wF.fileName); } catch (e) {}
  }
  if (!srcFile && !srcDir) return fsFail(404, { error: "no such file: " + from });
  // refuse overwrite semantics — dest must not exist.
  // 3.7.1 (tester request 3): the READ walk first — creating the
  // destination's parent folders BEFORE the approval card left empty
  // folders behind when the card timed out (K_moved/ bug). Parents are
  // now created only AFTER the gate.
  let wT = await walkToParent(rgT.rootRec, rgT.parts, false);
  const destParentsMissing = !wT;
  try {
    if (wT) {
      await wT.dir.getFileHandle(wT.fileName);
      return fsFail(409, { error: "destination exists: " + to,
        hint: "move never overwrites — delete or rename the destination first, or copy with /write_b64" });
    }
  } catch (e) { /* good */ }
  // 3.7.0 (tester should-fix): the approval card comes AFTER the
  // pre-checks — never approve a move that then 404/409s
  if (!internal) {
    const gate = await confirmGateLate("POST", "/move", body, ctx);
    if (gate) return fsFail(403, gate);
  }
  // approved (or internal): NOW create missing parents, then re-check
  // the destination name is still free (a file OR folder there = 409)
  if (destParentsMissing) {
    wT = await walkToParent(rgT.rootRec, rgT.parts, true);
    if (!wT) return fsFail(400, { error: "cannot create destination folders for " + to });
  }
  try {
    await wT.dir.getFileHandle(wT.fileName);
    return fsFail(409, { error: "destination exists: " + to,
      hint: "move never overwrites — delete or rename the destination first, or copy with /write_b64" });
  } catch (e) { /* good */ }
  try {
    await wT.dir.getDirectoryHandle(wT.fileName);
    return fsFail(409, { error: "destination exists: " + to,
      hint: "move never overwrites — delete or rename the destination first" });
  } catch (e) { /* good */ }
  // go
  if (srcFile) {
    const dst = await wT.dir.getFileHandle(wT.fileName, { create: true });
    await copyFileToFile(srcFile, dst);
    await wF.dir.removeEntry(wF.fileName);
  } else {
    await copyDirRecursive(srcDir, wT.dir, wT.fileName);
    await wF.dir.removeEntry(wF.fileName, { recursive: true });
  }
  await auditRow({ endpoint: "/move", method: "POST", path: rgF.relInRoot + " -> " + rgT.relInRoot, status: 200 });
  await refreshRootsCount();
  return fsOk(Object.assign({
    ok: true, moved: rgT.relInRoot, from: rgF.relInRoot,
    type: srcFile ? "file" : "dir",
  }, writtenFields(rgT)));
}

async function epMkdir(body) {
  const p = String(body.path || "").trim();
  if (!p) return fsFail(400, { error: "mkdir needs {\"path\": \"folder/sub\"}" });
  const rg = await resolveGuarded(unquoteComp(p), { forWrite: true });
  const rc = await rateCheck(0);
  if (!rc.ok) return fsFail(429, { error: rc.err, rate_limited: true, retry_after_s: 60 });
  const existed = await dirExists(rg.rootRec, rg.parts);
  if (!existed) {
    try {
      const w = await walkToParent(rg.rootRec, rg.parts, true);
      await w.dir.getDirectoryHandle(w.fileName, { create: true });
    } catch (e) {
      // Preserve master's collision contract for BOTH leaf and parent
      // files, while retaining the 3.7.3 canonical response fields.
      if (e && e.name === "TypeMismatchError") {
        return fsFail(409, { error: "cannot create '" + rg.relInRoot +
          "' — a file already exists on that path" });
      }
      throw e;
    }
  }
  await auditRow({ endpoint: "/mkdir", method: "POST", path: rg.relInRoot, status: 200 });
  await refreshRootsCount();
  return fsOk(Object.assign({ ok: true, created: rg.relInRoot, existed: existed },
    writtenFields(rg)));
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
  // hexRand(2) yields FOUR hex chars (n bytes → 2n chars) while older
  // docs implied 2 — accept both: all on-disk snapshot stamps are 4-char
  // (seen in .ofb-snapshots/ since 2026-09-08); a 2-char-tight regex
  // rejected every REAL stamp (bug found live by c7 on 2026-10-21).
  if (!/^\d{8}-\d{6}-[0-9a-f]{2,4}$/.test(ts)) {
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
  if (!rc.ok) return fsFail(429, { error: rc.err, rate_limited: true, retry_after_s: 60 });
  const snap = await snapshotBeforeWrite(rg.rootRec, rg.parts); // snapshot-on-restore
  const file = await srcFileHandle.getFile();
  await writeFileBytes(rg.rootRec, rg.parts, new Uint8Array(await file.arrayBuffer()));
  await auditRow({ endpoint: "/" + kind + "/restore", method: "POST", path: rg.relInRoot, status: 200, size: file.size });
  return fsOk({ ok: true, restored: rg.relInRoot, root_id: rg.rootRec.id, from: kind + "/" + ts, snapshot: snap });
}

/* ---------------- maintenance sweep: trash expiry + audit cap --------
 * (trash 30-day TTL since 2026-09-10; audit 1000-row cap same day.)
 * MV3 SWs have no reliable timers, so the sweep runs OPPORTUNISTICALLY:
 * sw.js fires it (unawaited) on pipe traffic, throttled to once per 24 h
 * (in-memory first — free — then a kv stamp across SW restarts; the kv
 * key keeps its historical name trash_sweep_ts). Trash entry age comes
 * from the directory name itself (tsStamp shape, local time);
 * unparseable names are left alone. Snapshots (.ofb-snapshots/) are NOT
 * pruned — deliberate: they are the undo net, and their cap is the 8 MB
 * per-file snapshot rule. The audit store is append-only by design, so
 * the sweep keeps its most recent AUDIT_MAX_ROWS rows (oldest deleted
 * first — autoIncrement keys are monotonic, one range delete). */

const TRASH_TTL_MS = 30 * 24 * 3600 * 1000;
const AUDIT_MAX_ROWS = 1000;
let _trashSweepMem = 0;

function trashEntryTsMs(name) {
  // [0-9a-f]{2,4}: tsStamp() = hexRand(2) = FOUR hex chars; the old
  // {2}-tight regex never matched a real trash dir, so the 30-day TTL
  // sweep silently skipped everything (found live 2026-10-21).
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-[0-9a-f]{2,4}$/
    .exec(String(name || ""));
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return isNaN(d.getTime()) ? null : d.getTime();
}

async function maybeSweepMaintenance(force) {
  try {
    const now = Date.now();
    if (!force) {
      if (_trashSweepMem && now - _trashSweepMem < 24 * 3600 * 1000) {
        return { skipped: "throttled" };
      }
      const last = await kvGet("trash_sweep_ts", 0);
      if (now - last < 24 * 3600 * 1000) return { skipped: "throttled" };
    }
    _trashSweepMem = now;
    await kvSet("trash_sweep_ts", now);
    const roots = await enabledRoots();
    let removed = 0;
    for (const r of roots) {
      let trash;
      try { trash = await r.handle.getDirectoryHandle(TRASH_DIR); }
      catch (e) { continue; }
      const stale = [];
      for await (const [name, h] of trash.entries()) {
        if (h.kind !== "directory") continue;
        const ts = trashEntryTsMs(name);
        if (ts != null && now - ts > TRASH_TTL_MS) stale.push(name);
      }
      for (const name of stale) {
        try { await trash.removeEntry(name, { recursive: true }); removed++; }
        catch (e) { /* in use / raced — next sweep retries */ }
      }
    }
    if (removed) {
      await auditRow({ op: "trash-expiry", path: TRASH_DIR + "/", status: 200, size: removed });
    }
    const trimmed = await auditTrimOver(AUDIT_MAX_ROWS);
    if (trimmed > 0) {
      await auditRow({ op: "audit-trim", path: "audit/", status: 200, size: trimmed });
    }
    return { removed: removed, auditTrimmed: trimmed };
  } catch (e) {
    return { error: String(e) };
  }
}

/** Keep the newest `cap` audit rows; returns how many were deleted
 * (-1 = store unreadable). Opens the DB VERSIONLESS — readers must
 * never request an upgrade (a stale pinned version throws VersionError
 * once fs-idb moves on; options.js's audit reader had exactly that bug
 * against v2). */
function auditTrimOver(cap) {
  return new Promise((resolve) => {
    const req = indexedDB.open("ofb-ext");
    req.onerror = () => resolve(-1);
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      let settled = false;
      const finish = (n) => {
        if (settled) return;
        settled = true;
        tx.oncomplete = () => { db.close(); resolve(n); };
        tx.onabort = tx.onerror = () => { db.close(); resolve(-1); };
      };
      let tx;
      try {
        tx = db.transaction("audit", "readwrite");
        const os = tx.objectStore("audit");
        const gk = os.getAllKeys();
        gk.onsuccess = () => {
          const all = gk.result || [];
          if (all.length <= cap) { finish(0); return; }
          // keep the newest `cap` keys (autoIncrement ⇒ monotonic ints);
          // exclusive upperBound on the cutoff deletes everything older
          const cutoff = all[all.length - cap];
          try {
            os.delete(IDBKeyRange.upperBound(cutoff, true));
            finish(all.length - cap);
          } catch (e) { finish(-1); }
        };
        gk.onerror = () => finish(-1);
      } catch (e) {
        try { db.close(); } catch (e2) {}
        resolve(-1);
      }
    };
  });
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
  if (!rc.ok) return fsFail(429, { error: rc.err, rate_limited: true, retry_after_s: 60 });
  // build the zip via the engine page (it has fflate) or inline fallback
  const zipped = await fsZipBytes(files.map((x) => ({ name: x.name, bytes: new Uint8Array(0), file: x.file })));
  const rgOut = await resolveGuarded(unquoteComp(outName), { forWrite: true });
  const snap = await snapshotBeforeWrite(rgOut.rootRec, rgOut.parts);
  await writeFileBytes(rgOut.rootRec, rgOut.parts, zipped);
  await auditRow({ endpoint: "/zip", method: "POST", path: rgOut.relInRoot, size: zipped.length, status: 200 });
  await refreshRootsCount();
  return fsOk(Object.assign({ ok: true, bytes: zipped.length, members: members.length, snapshot: snap }, writtenFields(rgOut)));
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
  if (!rc.ok) return fsFail(429, { error: rc.err, rate_limited: true, retry_after_s: 60 });
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
