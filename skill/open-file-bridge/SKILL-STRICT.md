---
name: open-file-bridge-strict
description: "MUST-CALL before ANY file task. User's real files are reachable ONLY via the local bridge (http://127.0.0.1:8765) — call this skill first and run its Bootstrap. Files written with open()/os in this sandbox are LOST and INVISIBLE to the user; claiming success without a bridge response is a failure."
---

# Local File Bridge — STRICT variant — skill v2.7

Built for models that need guardrails: fixed recipes, bridge-only writes,
verify-after-write. (Stronger models: use the standard "Local File
Bridge" skill instead — more endpoints, more freedom.)

## THE 10 RULES — follow exactly, never improvise

1. The user's files live in their **shared folder**, reachable ONLY
   through their Open File Bridge at `http://127.0.0.1:8765`. The Python
   sandbox (`/mnt/uploads/` or whatever `os.getcwd()` says) is **NOT**
   the user's folder — it is a throwaway scratch space.
2. **NEVER use `open()`, `os.*`, or `pathlib` to read or write user
   files.** A file written inside the sandbox is LOST — the user will
   never see it. Telling the user it was created would be a lie.
3. First action of every session: run the bootstrap block below (its
   `GET /health` doubles as the version check).
4. If `/health` fails or the fetch fails: say exactly — *"Your File
   Bridge app isn't running. Please start the Open File Bridge app on your
   computer, then ask me again."* — and STOP. Do NOT look in
   `/mnt/uploads`. Do NOT improvise. Maximum ONE retry.
5. To read: `/list` first, then `/stat` (or `/peek`) on the target,
   then the matching reader endpoint from the table below. Never
   `/read` a binary file (Office/PDF/image) — the error response tells
   you the right endpoint; follow its `hint`.
6. To write: ALWAYS a bridge POST endpoint (`/write`, `/edit`,
   `/docx_write`, `/xlsx_append`, `/pdf_from_text`, `/docx_merge`).
   NEVER local file APIs (Rule 2).
7. **HTTP 409 = the bridge wants confirmation.** Show the user what
   will change, then re-send the SAME payload plus the
   `"confirmation_token"` from the response (valid 60 s). Do NOT
   change any other field — the token burns on mismatch.
8. **After EVERY write: verify.** Re-read the file via the bridge (or
   confirm the response contains `"ok": true` and the `"written"`
   path) and report THOSE facts. Never claim success from your own
   belief — if you did not see a 200 from the bridge, say so.
9. Only touch files inside the shared folder. Never construct `../`
   paths. Never dump a whole large file into chat — summarize and cite
   `path:line`.
10. On any 4xx/5xx: read the `error` and `hint` fields and follow
    them. Still stuck? Tell the user the exact error text — do not
    guess.

## Bootstrap — run this first, copy it exactly

```python
from pyodide.http import pyfetch
import json

# If your admin gave the org a Tier-2 token it appears as an injected
# BRIDGE_HEADERS block above — use that instead of this default. No block
# but the user told you their personal token in chat? Add
# "X-Bridge-Token": "<it>" here for the session — never echo it back.
BRIDGE_HEADERS = {"Content-Type": "application/json"}

async def bridge_get(path, params=None):
    url = f"http://127.0.0.1:8765{path}"
    if params:
        url += "?" + "&".join(f"{k}={v}" for k, v in params.items())
    r = await pyfetch(url, headers=BRIDGE_HEADERS)
    t = await r.text()
    if r.status != 200:
        raise RuntimeError(f"bridge {path} -> HTTP {r.status}: {t}")
    return json.loads(t)

async def bridge_post(path, payload):
    r = await pyfetch(f"http://127.0.0.1:8765{path}", method="POST",
                      headers=BRIDGE_HEADERS,
                      body=json.dumps(payload))
    if r.status != 200:
        raise RuntimeError(f"bridge {path} -> HTTP {r.status}: {await r.text()}")
    return await r.json()

# session start (Rule 3) — ONE call: /health already carries the version:
h = await bridge_get("/health")
print(h.get("ok"), h.get("root"), h.get("version"))
```

`/health` → `{"ok": true, ...}` means running; it also shows the shared
root folder and the `version` (older than v2.5 → tell the user "the bridge
app and the skill are out of sync — re-run the installer"). Send
`BRIDGE_HEADERS` on EVERY call, GETs included. Non-200 bodies are JSON with
an `error` (+ often `hint`) — read and adjust; e.g. 401 "missing or invalid
bridge token" → add the token header, retry once.

## Recipe A — find and read a file (in this order)

1. `h = await bridge_get("/health")` — if it fails, Rule 4.
2. `files = await bridge_get("/list", {"path": "."})` — the user's
   files are HERE, nowhere else.
3. Not sure what a file is? `await bridge_get("/peek", {"path": p})`
   → follow its `hint`.
4. Read with the matching endpoint:

| File type | Endpoint |
|---|---|
| txt / md / code / csv | `/read?path=X` (windowed; `/csv_head` + `/csv_stats` for shape) |
| .xlsx | `/xlsx_read?path=X` (row_count, headers, data) |
| .docx | `/docx_read?path=X` |
| .pptx | `/pptx_read?path=X` |
| .pdf | `/pdf_text?path=X` — empty text = scanned → `/ocr?path=X` |
| image (png/jpg/…) | `/image_info?path=X` then `/ocr` if text is needed; `/image_b64` to SHOW it in chat |
| .eml | `/eml_read?path=X` |
| .html | `/html_text?path=X` |
| .doc/.xls/.ppt (legacy) | Recipe C first |

5. Summarize what you found; cite `path:line`. Show at most a screen
   of content unless the user asks for more.

Search across files: `/search?q=…&glob=…` (respects the user's ignore
lists — a missing file may be excluded on purpose; say so).

## Recipe B — create or modify (write ONLY via the bridge)

1. `GET /health` (Rule 3/4).
2. Pick the endpoint for the job:

| You want | Endpoint |
|---|---|
| write/edit plain text, md, csv, code | `/write {"path","content"}` (overwrite → 409 flow, Rule 7) |
| surgical text replacements | `/edit {"path","edits":[…],"dry_run":true}` — show the diff, then apply via 409 flow |
| new Word document | `/docx_write {"out":"x.docx","sections":[…]}` |
| new PDF | `/pdf_from_text {"out":"x.pdf","blocks":[…]}` |
| Excel rows (create or append) | `/xlsx_append {"path":"x.xlsx","rows":[[…]],"header":[…]}` |
| fill a .docx template | `/docx_merge {"path","out","values":{…}}` |

3. POST it. 409 → Rule 7 (confirm with the user, resend same payload
   + token).
4. **VERIFY (Rule 8):** re-read via the bridge OR report the
   response's `"written"` path and byte count. Example:
   `d = await bridge_post("/write", …)` → tell the user
   `d["written"]` — never "I created it" without this.
5. State the exact final path in your answer, then make it clickable:
   the write response already has `d["links"]` — append
   `**`name`** · [📄 Open](d["links"]["open_url"]) · [📂 Show in folder](d["links"]["reveal_url"])`
   (folders: Show in folder only). Passing mentions stay plain code spans.
   No `d["links"]` (older bridge) → plain code span, no extra call.

## Recipe C — legacy formats (.doc/.xls/.ppt)

Convert to a modern format first, then Recipe A/B on the product:

```python
d = await bridge_post("/convert", {"path": "old.doc", "out": "new.docx"})
# 409 confirmation flow applies (Rule 7). 501 → the user has no
# LibreOffice: say so and ask them to convert manually.
```

## Error phrases — say these EXACTLY, then stop

| Response | Tell the user |
|---|---|
| fetch/`/health` failure | "Your Open File Bridge app isn't running. Please start the Open File Bridge app, then ask me again." |
| 401 | "This bridge requires an access token — please ask your admin." |
| 403 read-only | "The bridge is in read-only mode — switch it off in the Open File Bridge settings if you want edits." |
| 429 | "The write-rate safety brake tripped (many writes in a minute). Please confirm you want me to continue." |
| 501 | "This Open File Bridge install lacks a needed component — see its admin guide." |

## Detection

`await bridge_get("/health")` → `{"ok": true}` = running. Anything
else → Rule 4. `/health` reports the bridge version; older than v2.5
→ out of sync.
