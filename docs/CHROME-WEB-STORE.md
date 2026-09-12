# Publishing Open File Bridge in the Chrome Web Store

Everything needed for the Chrome Web Store submission of the **extension**
(the MV3 product line; the desktop app is distributed via GitHub Releases and
the Microsoft Store, not the CWS).

## 1. Package to upload

`dist-stage3/open-file-bridge-extension-3.3.1.zip`

- Manual zip of the git-tracked `extension/` directory — **no build step**.
  `manifest.json` is at the ZIP root; 77 files; no `__MACOSX`/`.DS_Store`.
- ~46 MB compressed (~99 MB raw), driven by the bundled `vendor/tessdata-fast`
  OCR languages. Well under the store limit; expect a normal-length review.
- Re-zip after any `extension/` change (and bump `"version"` — the store
  rejects a re-used version number). Delete the superseded zip.
- Version 3.3.1 notes: manifest description shortened to 116 chars (store max
  132); vestigial `storage` permission removed (all state lives in
  IndexedDB; persistence + offscreen smoke re-verified after removal).

## 2. Listing fields

| Field | Value |
|---|---|
| Name | Open File Bridge |
| Summary | (the 116-char manifest description, auto-filled) |
| Category | Productivity |
| Language | English (US) |

### Detailed description (paste into the store)

> Open File Bridge connects your self-hosted Open WebUI to ONE folder on
> your computer — the folder you pick. Your AI chat can then list, read,
> write, search, OCR, and convert files in that folder, while everything
> stays on your machine.
>
> Why: Open WebUI's code interpreter runs in a sandbox that cannot touch
> your files. Open File Bridge gives it a locked door — you choose the
> folder, you choose the ONE website allowed to use the door, and the
> extension enforces both.
>
> How it works:
> 1. Pick a folder in the extension's settings.
> 2. Allow your Open WebUI address (for example http://127.0.0.1:8080 or
>    https://chat.example.com) and optionally set a bridge token.
> 3. Install the bridge skill in Open WebUI (copy-paste from the GitHub
>    repo) and turn on the code interpreter in a new chat.
> 4. Ask: "list the files in my folder", or "write the summary to notes.md".
>
> Safety model:
> - One folder only — nothing outside it is visible.
> - One site only — every other origin is refused; an optional bridge token
>   stops a fake page impersonating your Open WebUI address.
> - Approve/Deny cards inside the chat page for deletes and overwrites;
>   every overwrite keeps the previous version; deletes go to a 30-day trash.
> - Read-only mode, write-rate brake, ignore patterns, and built-in refusal
>   of credential-looking files (.env, id_rsa, *.pem, …).
> - Local-only: no cloud, no accounts, no analytics, no telemetry. Files go
>   nowhere except to your own Open WebUI when it asks.
>
> Extras: OCR in 20+ languages (runs locally in the extension), PDF text
> extraction, xlsx→csv and docx→html conversion, and full-text search.
>
> Where your Open WebUI must run: on the same computer (localhost), on your
> LAN, or on a server you control — for a public HTTPS deployment, set a
> bridge token and see the repo's user guide. Stock cloud Open WebUI without
> browser file access is not supported.
>
> Requires Open WebUI with the code interpreter enabled. The bridge skill
> file, setup guide, and source code:
> https://github.com/Sparkling-AI/open-file-bridge

## 3. Graphics

All in the repo, correct store dimensions, rendered from the real extension
pages in a fresh synthetic profile (no real user data appears):

| File | Size | Shows |
|---|---|---|
| `docs/screenshots/cws-1-options-fresh.png` | 1280×800 | Onboarding: Get-started steps, Shared folders, Security |
| `docs/screenshots/cws-2-options-security.png` | 1280×800 | Configured site lock + bridge token |
| `docs/screenshots/cws-3-options-ocr-safety.png` | 1280×800 | OCR language grid, Safety & recovery |
| `docs/brand/promo-tile-440x280.png` | 440×280 | Promotional tile (mandatory) |

Optional: icon assets in `extension/icons/` (16–256) already satisfy the
store icon requirement; a 1280×800 marquee can be added later.

## 4. Privacy tab

- **Privacy policy URL** (public HTTPS):
  `https://github.com/Sparkling-AI/open-file-bridge/blob/master/docs/PRIVACY.md`
  — `docs/PRIVACY.md` covers the extension (and the desktop app); keep the
  "Last updated" date current when behavior changes.
- **Single purpose:**
  > Lets the user's own Open WebUI instance read and write files in one
  > user-selected folder on the user's computer, under a user-configured
  > site lock.
- **Permission — `offscreen`:**
  > Runs OCR (Tesseract WASM) and document conversion in an offscreen
  > document so no extra tabs or windows open on the user's machine.
- **Content scripts on `https://*/*`, `http://127.0.0.1/*`,
  `http://localhost/*` (broad matching justification):**
  > The content script is a passive message relay so the extension works
  > with any self-hosted Open WebUI origin — users choose their own address
  > (localhost, LAN, or a custom domain), so the origins cannot be
  > pre-listed. The relay only forwards bridge-shaped messages; it collects
  > nothing and grants nothing by itself. All file-operation requests are
  > rejected by the extension's service worker unless the sender's origin is
  > on the user's explicit allowlist (checked against browser-provided
  > sender metadata), with an optional user-set bridge token as a second
  > lock. Until the user allowlists a site, every request is refused.
- **Data-use disclosures (recommended honest answers):**
  - Handles user data (file names/contents in the user-selected folder):
    yes, transferred only to the user's own allowlisted site on that site's
    request.
  - Sells or transfers data to third parties for non-core purposes: **no**.
  - Uses data for analytics/telemetry beyond core functionality: **no**.
  - Uses data for advertising/attribution: **no**.

## 5. Reviewer test recipe (no Open WebUI required)

1. Load the extension (unpacked or from the zip) and open its options page.
2. Click **Choose folder…** and pick any test folder.
3. In **🔒 Security**, set the site to any page origin you control for
   testing (e.g. `https://example.org`), then open that page.
4. In that page's DevTools console, ride the same pipe the Open WebUI skill
   uses:

   ```js
   await new Promise((res) => {
     const id = Math.random();
     addEventListener("message", function h(ev) {
       if (ev.data.ofb && ev.data.id === id) {
         removeEventListener("message", h); res(ev.data);
       }
     });
     postMessage({ ofb: true, id, method: "GET", path: "/list" }, "*");
   });
   ```

   The response lists the test folder's files as JSON. Requests from any
   non-allowlisted origin return a refusal — that is the site lock working.

## 6. Submit

1. One-time $5 developer registration fee on the Google account that will
   own the listing (Sparkling AI's account, Dandan's login — submission must
   happen from that account).
2. Upload the zip, fill the listing from sections 2–4, attach the graphics.
3. Publish first to **trusted testers** (unlisted), install from the store
   on a clean profile, then publish to everyone.
4. After publication, keep this file and `docs/PRIVACY.md` in sync with
   what ships.
