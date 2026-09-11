# TODO / Known Issues

Things deliberately left open (with reasons) before/after the v1 rollout.

## 1. Lock CORS to your Open WebUI origin — **do this before real users** ⚠️

**What:** `src/file_bridge.py` currently ships with:

```python
CORS_HEADERS = [
    ("Access-Control-Allow-Origin", "*"),   # ← anyone
    ...
]
```

**Why it matters:** the bridge binds to `127.0.0.1`, so *remote* attackers
can't reach it — but any *website the user visits* runs JavaScript in their
browser, and that JS can try `fetch("http://127.0.0.1:8765/read?...")` from
the user's own machine. With `*`, a malicious page can silently list and read
the shared folder (and write files into it). Chrome's Local-Network-Access
prompt makes the user click "Allow" once per *site* — but if the user browses
your OWUI in Chrome and a bad site in another approved context, or uses a
browser without LNA (Firefox), the wildcard is the only thing standing between
that page and the files. LNA is also still per-site-remembered, social-
engineering-able, and not present at all on older browsers.

**Fix (one line + restart):**

```python
OWUI_ORIGIN = "https://owui.yourorg.com"     # exactly your instance origin
CORS_HEADERS = [
    ("Access-Control-Allow-Origin", OWUI_ORIGIN),
    ("Access-Control-Allow-Private-Network", "true"),
    ("Access-Control-Allow-Methods", "GET, POST, OPTIONS"),
    ("Access-Control-Allow-Headers", "Content-Type"),
]
```

Then the browser itself refuses cross-origin calls from every other site —
your OWUI keeps working, everything else gets blocked by CORS, not by trust.

**Why we didn't ship it locked:** the origin differs per deployment; a
hardcoded wrong origin breaks the out-of-the-box demo. Options to make it
safe *and* turnkey (pick one, implement in `src/file_bridge.py`):

- [x] First-run picker page asks for the OWUI URL and saves it next to the
      folder choice in `~/.file-bridge.json` (best UX for non-technical users)
      — DONE since the v2 picker (state.json) + origin field; 2.4 polished it
      (Browse… dialog, OS-specific placeholder, live status, Stop button)
- [ ] Config/env override: `FILE_BRIDGE_ALLOWED_ORIGIN` env var
- [ ] Build-time flag baked into each org's installer

## 2. Binary file support (PDF/xlsx/images) — future

Reads are text-only (`read_text(errors="replace")`). For PDFs etc., add:

- [ ] `/read_b64` endpoint returning base64 (Pyodide can decode, and OWUI can
      render images from data URLs; PDFs would still need parsing client-side)

Keep the 200 KB cap or make it size-aware per mime type.

## 3. Code signing — removes install friction

- [ ] **Windows:** EV cert + `signtool` on `OpenFileBridge.exe` kills the
      SmartScreen "More info → Run anyway" step. Without it, expect a couple
      of support questions per hundred users.
- [x] **macOS:** DONE 2026-08-30 — Sparkling AI AB Developer ID + notary
      profile `ofb-notary`; `package_macos.sh --sign` fixed (hardened runtime,
      timestamp, stapler, post-staple re-zip, entitlements) and live-verified:
      notarized Accepted, staple survives the shipped zip, `spctl` =
      Notarized Developer ID, signed app runs and serves v2.8 with
      wheels/OCR from Contents/Resources. Users now just double-click.

## 4. Auto-start / keep-running UX

Bridge must be running during chats. Non-technical users will forget.

- [ ] Windows installer option: registry Run key (Inno Setup `[Registry]` section)
- [ ] macOS: LaunchAgent plist (`~/Library/LaunchAgents/com.yourorg.openfilebridge.plist`)
- [ ] Linux: note in user guide about systemd --user unit
- [ ] Tray icon / menu-bar indicator so users can see it's running (needs a
      GUI dep — currently avoided deliberately to stay stdlib-only; acceptable
      cost when we accept a GUI toolkit, or use native notifications).
      2.6.3 partial: clicking the app icon now opens the settings page on
      both platforms (macOS Dock-click reopen delegate; Windows relaunch
      defers to the running bridge) — a tray would still help Windows
      discoverability at a glance.

## 5. Write-safety guardrails

- [ ] Optional read-only mode (`FILE_BRIDGE_READONLY=1` disables `/write`)
- [ ] Append-only mode for notes-type folders
- [ ] `.ofb-ignore` file support (like .gitignore) for secrets inside
      the shared folder (e.g. `.env`, `id_rsa`)

## 6. Model-side robustness

- [ ] Preset system prompt line: "never write without confirming the target
      filename with the user first" (cheap, catches most accident classes)
- [ ] If weak models hallucinate bridge responses, enforce skill via
      `$open-file-bridge` mention in prompt suggestions
- [ ] Bridge: `do_GET`'s 404 fallback should detect paths routed in
      `do_POST` (`/versions/list`, `/trash/list`, …) and answer 405 with a
      "use POST + JSON body" hint — today it replies "unknown endpoint",
      which misled a model into declaring the endpoints unsupported
      (skill 2.11.1 teaches the workaround; the bridge hint would fix any
      client in one round trip)

## 6b. Stage 3 (extension) follow-ups

- [ ] Re-run the Linux stage-3 suites (spike1/engines/negatives/confirm,
      Xvfb) after the 2026-09-09 worker-transport relay change — the
      Mac-runnable `tests/stage3/worker_transport_test.py` (7/7) covers
      both transports and the election, but the picker-driven paths and
      the engines/confirm suites were not re-run on this machine.
      The 2026-09-10 language expansion (ext 3.0.11) also needs that
      engines run: e11 now asserts 21 langs in alphabetical order, and
      no new-lang OCR (rus/jpn/…) has been exercised live yet — only
      static checks ran on the Mac. UPDATE 2026-09-11 (sender gate, ext
      3.0.18): all four picker suites now call `spike1.sec_configure`
      after the picker (origin + TEST_TOKEN; worker_transport is
      origin-only) — the new `sec_test.py` (13/13 Mac) covers the gate
      itself; the Linux re-run must confirm the four still pass WITH
      the gate on.
- [ ] Onboarding copy beyond the options card: README still documents
      only the APP setup (no extension section — it should also name the
      TWO skill variants, SKILL-EXT.md vs SKILL-EXT-TOKEN.md); the CWS
      store listing (chat-only draft) needs the same skill +
      code-interpreter steps; when feat/stage3-extension merges to
      master, repoint the Get-started card's skill-file links
      (options.html SKILL_FILE_BASE, currently branch-scoped) — until
      the next push those links serve the OLD skill (3.0.5-EXT on the
      remote).
- [ ] Dandan's Chrome, once, after loading ext 3.0.18: options → 🔒
      Security → allow `http://127.0.0.1:8788` (one click under
      Recently blocked) and optionally Generate+Save a bridge token
      (paste in chat once when the model asks).
- [x] CWS zip current at 3.1.1 (2026-09-12, link-repoint build):
      `dist-stage3/open-file-bridge-extension-3.1.1.zip` — 48.4 MB
      compressed / 80 files / manifest 3.1.1 verified inside; the 3.1.0
      zip was REMOVED so the stale one can't be uploaded. Actual CWS
      upload still pending Dandan's store step.
- [ ] confirm_test.py was rewritten for the 2026-09-09 blocking-confirmation
      contract (c0 approve-mid-wait, c1 timed_out, c5 deny-mid-wait) but
      only runs on Linux/Xvfb — first run there must confirm it green.
- [ ] osd.traineddata (10.6 MB) sits in the extension bundle unreferenced
      by any code — drop it or wire it into orientation detection,
      Dandan's call (app bundles it too, so parity keeps it for now).

## 7. CI gaps

- [x] Windows/macOS smoke tests in Actions — done 2026-08-28: every matrix
      leg now starts its own artifact, polls `/health`, and asserts
      `addons.pdf` (pymupdf frozen in) + wheel count. Windows spec fixed to
      one-folder output so `installer_windows.iss` finds the exe where it
      expects; artifact upload paths corrected (macOS uploads the packaged
      `.app` zip, Windows the onedir folder) with `if-no-files-found: error`
      so an empty artifact can never pass silently again.
- [ ] Auto-attach artifacts to GitHub Releases on tag (repo now lives at
      github.com/Sparkling-AI/open-file-bridge, master pushed and in sync)

## 8. Windows real-machine desktop flows (remaining)

CI smoke (GitHub Actions windows-latest) covers build + startup + health +
frozen addons. Still needs a real Windows desktop, per the original plan:

- [ ] First real Inno Setup compile of `build/installer_windows.iss`
      (spec output layout now matches its expected `dist\OpenFileBridge\` path)
- [ ] SmartScreen "More info → Run anyway" flow on first run
- [ ] NTFS symlink/junction behavior of the resolve guards (POSIX paths,
      drive letters `C:\`, UNC `\\server\share` and backslash traversal are
      rejected by design and unit-checked on macOS; NTFS reparse points
      need real-Windows confirmation)

## 9. Outcome links (2.7) — follow-ups

- [ ] Rebuild frozen artifacts (.app + zip) at 2.7 so packaged users get
      /link + /click (dist still 2.6); restage skill is done via
      scripts/setup_owui.py
- [ ] Windows real-machine check of `_launch_external`: `explorer /select,`
      with quoted paths containing spaces, and `os.startfile` on a folder
      (code-reviewed only — no Windows box this round)
- [ ] After some real usage: consider surfacing "link expired" reports in
      the model's own words (skill says just re-mint) — if users hit
      expiries often, raise FILE_BRIDGE_LINK_TTL default instead
