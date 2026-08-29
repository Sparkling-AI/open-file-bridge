# Open File Bridge — User Guide

Open File Bridge lets **your** Open WebUI chats read and write files in **one folder
on your own computer**. Your files never pass through the Open WebUI server —
everything happens between your browser and your own machine.

## Requirements

- **Browser: Chrome, Edge, or Firefox.** ⚠️ **Do NOT use Safari** — Safari
  blocks web pages from calling `http://127.0.0.1` services, so Open File Bridge
  cannot work there. This is a hard Safari limitation, not a bug.
- One of: Windows 10/11, macOS 11+, or Linux.
- The Open File Bridge app (get it from your admin, or Downloads below).

## Install & first run

### Windows
1. Download `OpenFileBridge-Setup.exe` (or `OpenFileBridge.exe`).
2. Double-click. If Windows shows **"Windows protected your PC"**
   (SmartScreen — normal for new unsigned apps): click **More info → Run anyway**.
3. Your browser opens the Open File Bridge page. Pick the folder to share with
   **Browse…** (native folder dialog), or paste a path, e.g.
   `C:\Users\you\Documents\my-project`, then click **Save folder**.
4. Done. A small Open File Bridge process now runs in the background
   (a green ● on its settings page confirms it is live). To see or change
   anything later, double-click its icon again (Start menu / desktop) —
   the settings page opens in your browser; your folder choice is
   remembered.

### macOS
1. Download `OpenFileBridge-macos.zip`, unzip it, drag **OpenFileBridge** into **Applications**.
2. First launch: **right-click OpenFileBridge → Open → Open**
   (bypasses Gatekeeper for unsigned apps — needed only once).
3. Your browser opens the Open File Bridge page. Pick the folder to share with
   **Browse…** (native folder dialog), or type/paste a path, e.g.
   `/Users/you/Documents/my-project`, then click **Save folder**.
4. Done. Open File Bridge runs in the background with an **icon in the Dock** —
   that is how you can see it is running. **Click the Dock icon any time to
   open the settings page** (status, folder, security, OCR). Stop it with
   the **Stop Open File Bridge** button at the bottom of the settings page, or
   quit it from the Dock (right-click → Quit). Launching it again while it
   runs also just opens the settings page.
5. OCR languages: tick one or more checkboxes (e.g. English + Swedish —
   combining fixes å/ä/ö *and* digits). Codes can also be typed manually.

### Linux
Either run the binary:
```bash
chmod +x OpenFileBridge
./OpenFileBridge ~/my-folder
```
or with Python (no install needed — stdlib only):
```bash
python3 file_bridge.py ~/my-folder
```

## Using it in Open WebUI

1. In Open WebUI, select the model your admin prepared
   (usually called **"Local Files Assistant"**).
2. Just ask naturally: *"List the files in my folder"* or
   *"Read notes.txt and summarize it"* or *"Write a draft to report.md"*.
3. **First time only:** the browser shows a permission prompt —
   - Chrome/Edge: *"Open File Bridge wants to access devices on your local network"* → click **Allow**
   - Firefox: no prompt (localhost fetches are allowed silently)
4. That's it. The AI reads/writes only inside the folder you chose.

## What to watch out for

| Thing | What happens | What you do |
|---|---|---|
| Browser local-network prompt | Appears once (Chrome 142+/Edge) | Click **Allow** — this is what authorizes the connection |
| Safari | Blocked entirely | Use Chrome, Edge, or Firefox instead |
| SmartScreen / Gatekeeper warning | First launch of unsigned app | Windows: More info → Run anyway · macOS: right-click → Open |
| Bridge not running | AI says it can't reach your files | Start the Open File Bridge app again |
| Wrong folder | AI sees old/other files | Open `http://127.0.0.1:8765` in your browser, change folder, Save |
| Corporate VPN/antivirus | May block localhost traffic | Rare; allow `OpenFileBridge.exe` / port 8765 in your security tool |

## Privacy & security

- Open File Bridge **only** exposes the **one folder** you selected. Nothing else.
  It's technically impossible for the AI to read outside it (path traversal is
  rejected server-side — tested).
- Destructive operations are guarded: every overwrite/delete asks for
  confirmation, snapshots previous versions first, and moves deleted files to
  a trash folder instead of erasing them.
- The service binds to `127.0.0.1` only — not reachable from your network or
  the internet, only from your own browser.
- Every request is logged to a local audit file in the bridge's state folder.

### Token (optional extra lock)

On the settings page (`http://127.0.0.1:8765`), under **🔒 Security**, the
**token** field is an optional second lock: when set, requests must also
carry it in an `X-Bridge-Token` header.

**Recommended for individuals — a private token nobody else has:**

1. Click **Generate random token** (🔒 Security section).
2. Tell the model the token once in chat — e.g. *"my bridge token is
   `<the token>`, use it for this session"* — the skill instructs the model
   to add it to every request. (Or, to avoid repeating it: make your own
   private copy of the skill in Open WebUI and paste the token into its
   bootstrap block.)
3. Don't share it. It never leaves your machine except to your own bridge.

**If your company gave you a token:** paste that exact token into the same
field (🔒 Security → token field → **Set token**). Everyone in the company
receives the same one — it's a company-boundary credential (it stops local
programs and other websites from using your bridge), not a secret from
colleagues. If you'd rather have a private one anyway, ask your admin to
stage the skill without an embedded token and use the individual flow above.

## OCR language

Open File Bridge reads scans in your language. Open `http://127.0.0.1:8765`, set
**OCR language** (e.g. `swe+eng` for Swedish documents with English words,
`chi_sim+eng` for Chinese). The list of installed languages is shown there.
Changing it takes effect immediately — no restart needed. The standard install
bundles 22 languages out of the box: English, Swedish, Danish, Norwegian,
Finnish, German, French, Spanish, Italian, Portuguese, Russian, Polish,
Hungarian, Latvian, Lithuanian, Estonian, Chinese (Simplified + Traditional),
Japanese, Korean, and Arabic — plus auto-detect for page orientation.

## PDFs, scans and photos

If your admin bundled the PDF/OCR add-on (included in the standard installer):

- *"What's in invoice.pdf?"* — works even for scanned documents (OCR)
- *"Read this receipt photo"* — OCR on png/jpg images
- *"Find the total in the scanned contract"* — search recognized text

Scanned pages take ~1–3 seconds each.

**"Describe this photo" needs one extra step.** OCR reads text inside
images, and the model can show an image inline in the chat — but it
cannot visually inspect files inside your shared folder (that's Open
WebUI's architecture, not the bridge). To let a vision model actually
*see* an image, attach the file to your chat message (📎) and ask about
it there.

## Troubleshooting

**"Bridge isn't running"** — Start Open File Bridge (Windows: Start menu; macOS:
Applications; Linux: run the binary/script). Verify: open `http://127.0.0.1:8765/health`
— should say `"ok": true`.

**AI says no code execution available** — Your admin's model preset wasn't
selected. Pick the prepared model (e.g. "Local Files Assistant") in the chat.

**Nothing happens after Allow** — Ask again; the first request sometimes needs
a second try while the permission settles.

**Want to stop sharing?** Just quit Open File Bridge. To reset the folder choice,
delete `~/.file-bridge.json` (Windows: `C:\Users\you\.file-bridge.json`).
