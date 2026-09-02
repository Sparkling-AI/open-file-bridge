# RESEARCH: Agentic KB search in Pyodide (prototype, 2026-09-02)

**Question** (Dandan): instead of answering from RAG, can the code
interpreter pull Knowledge-Base files from the OWUI server into the
browser's Pyodide environment and run code against them — agentic
search in a virtual filesystem?

**Answer: yes — verified end-to-end on OWUI 0.11.3 (owui-test),
real browser, glm-5.3-flash.** Numbers computed in-sandbox from raw
CSV bytes came out exact; text answers quoted from fetched
pdf/docx/md. Full transcript evidence in this doc.

## Part A — what OWUI stages by itself (negative result, important)

With a KB attached to a model preset and the code interpreter enabled,
a probe (`os.walk('/mnt')`) run via chat shows **`/mnt` is EMPTY**.
KB files are NOT staged into the Pyodide FS. The parent-page plumbing
(`+layout.svelte` → `getFileContentById` → worker `fsUploadFiles` →
`/mnt/uploads`) fires only for **chat attachments** referenced in
`metadata.files`; `model_knowledge` is merged into `form_data['files']`
as collection references for the RAG path only (middleware.py ~L2594,
L6098) and is not part of the `execute:python` payload. So KB-attached
files today = embedding + `query_collection`, nothing else. The idea in
this experiment fills a real gap (matches upstream asks #9614, #10510).

## Part B — the prototype recipe (verified working)

System prompt on a preset (both code-interpreter switches ON, KB
attached, base model glm-5.3-flash) instructs the model to:

1. **List KB files**: `GET /api/v1/knowledge/{kb_id}/files`
   → `{items: [{id, filename, ...}]}` (0.11.3 route; requires read
   access — admin/owner/access grant).
2. **Fetch extracted text**: `GET /api/v1/files/{id}`
   → `data.content` = OWUI's server-side extraction (status
   `completed`). Works for md/pdf/docx — **no client-side parsing
   needed**, exactly the "download the file content instead of the
   real file" simplification. Costs one request per file.
3. **Spreadsheets are the exception**: OWUI's extractor FLATTENS csv
   into `key: value` lines (`month: 2026-01 region: North ...`) —
   fine for lookup, WRONG for math. For numeric work fetch **raw
   bytes**: `GET /api/v1/files/{id}/content` and parse with
   csv/pandas. (xlsx raw bytes + openpyxl via bridge wheels or
   micropip would be the analog.)
4. Write fetched text into the Pyodide FS (e.g. `/mnt/kb/`), grep /
   read / compute locally, cite `[filename]` + exact figures.

**Auth**: the sandboxed iframe (`Origin: null`) CAN fetch the OWUI
API: preflight echoes `access-control-allow-origin: null` and allows
the `authorization` header (verified by probe + by the working run).
The browser page has no cookie in the iframe, so the code needs a
Bearer token passed in the prompt (prototype) — see Limitations.

**Verified transcript (single question, ~90 s)**: fetched all 4 files
(server log shows knowledge/files → 3× file record → csv /content),
answered: termination clause **90 days** (docx), total revenue
**955,000 SEK** (computed), plus by-region 519k/436k and monthly
215/231/246/263k — aggregates that exist NOWHERE as prose: proof the
math ran on real fetched data, not memorized/embedded chunks.

## API notes (0.11.3)

- Creating a model preset via API needs `base_model_id` set (null →
  invisible in picker) AND a public read `access_grants` entry
  (`{resource_type: 'model', principal_type: 'user', principal_id:
  '*', permission: 'read'}`) — the old `access_control: null` no
  longer makes a preset public.
- `POST /knowledge/create` with `files: [...]` did NOT attach files
  (KB showed 0 files). Use `POST /api/v1/knowledge/{id}/files/batch/add`
  with `[{file_id}, ...]` — that worked, files then appear and embed.
- `GET /api/v1/knowledge/{id}` returns `files: null`; the file list
  lives at `GET /api/v1/knowledge/{id}/files` (paged, `include_content`
  flag exists but items came back content-less — fetch per file).

## Limitations / next steps

- **Browser-only** (API consumers get nothing — Pyodide is the
  browser). Server-side Jupyter engine would cover API; different
  trust model.
- **Token in system prompt** is fine for a prototype but visible to
  anyone who can read the model record; production shape = a skill
  (like open-file-bridge's token variants) or a dedicated
  scoped-read service account.
- One request per file + full-text in memory: fine for small KBs;
  large KBs want a server-side listing+range API or the Jupyter route.
- Natural extension: merge with the bridge — local files AND server
  KB in one sandbox filesystem.
