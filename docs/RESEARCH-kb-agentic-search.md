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

## Part C — filter-based per-user token injection (verified 2026-09-03)

Production shape for auth: an OWUI **Filter function**
(`docs/prototype-kb-token-filter.py`, installed as
`kb_agentic_token_injector`) whose `inlet(body, __user__)` hook mints a
**short-lived (10 min) JWT for the calling user** via the platform's own
`open_webui.utils.auth.create_token({"id": user.id})` and prepends a
system message with recipe + token. No token ever stored in the model
record; each request gets a fresh token for whoever is chatting.

Verified on 0.11.3 (real browser, glm-5.3-flash):
- **Admin (KB owner)**: full agentic answer — 90 days termination
  (docx quote), 955,000 SEK total computed from raw CSV bytes, monthly
  table, "used raw CSV not the flattened extracted text".
- **Bob (regular user, NO KB grant)**: his minted token hits the KB
  list and gets 400 permission-denied → model reports
  "Access to the KB was denied (HTTP 400, permission error)",
  "I won't guess or fabricate either figure", and helpfully suggests
  the two fixes (grant access / attach files in chat). Per-user ACLs
  enforced end-to-end, honest failure on denial.

Gotchas found while wiring (0.11.3):
- Function **ids allow only `[A-Za-z0-9_]`** (hyphens rejected).
- `functions/create` installs the function **inactive**; activate via
  `POST /functions/id/{id}/toggle`, set valves via
  `POST /functions/id/{id}/valves/update` (valves in the create body's
  meta are ignored).
- Attach the filter by putting its id in the preset's
  `meta.filterIds` (models/model/update).
- **Chained base-model access**: `check_model_access` walks the
  `base_model_id` chain and a base model WITHOUT a `models` table row
  is admin-only ("a shared preset cannot be used to reach a base model
  the caller could not use directly"). For non-admin users to use a
  preset over a connection model, create a public model row for the
  base id (or grant it to a group).
- Filter system-message injection survives the pipeline; the model
  used the token verbatim and did not echo it.

Security notes: token TTL 10 min (valve); the token appears in the
prompt so it IS visible to the model itself (same trust level as the
baked-prompt variant, but per-user + expiring); a strict-skill-style
"never print the token" line is included in the recipe. A stronger
variant would mint a token with a narrowed scope (read-only file/
knowledge routes) — needs server support for scoped tokens.
