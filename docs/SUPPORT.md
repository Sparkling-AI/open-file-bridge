# Support runbook — the three support calls you'll actually get

Triage card for helpdesk/support. Each section: symptom → likely cause →
fix → what to ask back. All assume the File Bridge desktop app/service
is the deployed artifact.

## 1. "Windows protected your PC" (SmartScreen)

**Cause:** unsigned exe — Windows flags any new unsigned binary with
no reputation. Expected for current builds (signing matrix deferred,
ROADMAP P3).

**Fix (user-facing, 30 seconds):**
1. On the blue dialog click **More info** (easy to miss — bottom left).
2. **Run anyway**.
3. Optionally stop future warnings: right-click exe → Properties →
   check **Unblock** → OK (per-file, before first run).

**When it is NOT SmartScreen:**
- Dialog says "Unknown publisher" AND buttons are Disabled/Remove →
  that's Defender *policy* (enterprise): the org's ASR rules block
  unsigned binaries — needs IT to allowlist the file hash
  (Get-FileHash → Defender exclusion). Not user-fixable.
- Orange/red browser warning instead → they downloaded from a weird
  source; re-download from the internal share; verify hash.

**Escalation rule:** if more than ~10% of a rollout hits the Defender
*policy* variant, that's the signal to revisit the signing matrix
(Windows OV cert ~$100–200/yr kills both variants) — track in the
rollout notes.

## 2. Port conflict — bridge won't start / "port already in use"

**Symptom variants:**
- Console/service log: `[Errno 98] Address already in use` (Linux) or
  `WinError 10048` (Windows).
- User reports "bridge page won't open" at http://127.0.0.1:8765.

**Diagnose:**

```bash
# Windows (admin PowerShell)
netstat -ano | findstr :8765
tasklist /fi "PID eq <pid from above>"

# Linux/macOS
ss -tlnp | grep 8765        # or: lsof -i :8765
```

**Causes & fixes (in frequency order):**

1. **A previous bridge instance didn't exit** (most common; e.g. user
   "closed the window" but the service kept running). Fix: stop the
   old one —
   ```bash
   # Windows
   taskkill /pid <pid> /f
   # Linux (service install)
   systemctl --user stop file-bridge
   ```
   …or just USE the running one: open http://127.0.0.1:8765 — if it's
   ours and healthy, done.
2. **Another app holds 8765.** The bridge supports
   `FILE_BRIDGE_PORT=xxxx` env override. For the service install,
   `scripts/install_service.py` bakes the env in. Pick e.g. 8799, then
   the SKILL must match — re-run `setup_owui.py` (it patches the
   skill's bootstrap URL), or hand-edit the skill's
   `http://127.0.0.1:8765` occurrences. Both places: skill markdown
   AND user expectations ("it's on 8799 now").
3. **Software using ephemeral ports colliding** (rare, dev machines
   with port scanners): retry — 8765 is outside ephemeral ranges on
   all three OSes by default.

**Ask back:** "What does http://127.0.0.1:8765/health return?" —
`{"status":"ok"}` means the conflict is two bridges, not a foreign app.

## 3. "It says my browser isn't supported" / Safari

**Cause:** hard limitation — Safari (all versions, incl. Technology
Preview as of 2026-08) blocks fetch from a secure page to localhost
(private-network/local-network access), which is the bridge's entire
transport. Not fixable by the bridge, not a bug.

**Fix:** use Chrome, Edge, or Firefox — desktop versions. (Chrome's
Private Network Access may add a permission prompt on first bridge call
per site: accept it.)

**What to tell the user:** "Safari can't talk to local apps from a web
page — Apple restricts it. Chrome/Edge/Firefox work; your files stay
local either way."

**Related, don't confuse:** if Chrome shows "This page can't access
the local network" — settings → Privacy → Local Network Access →
allow the OWUI origin (PNA prompt, iOS-style toggle appearing on
desktop Chrome as PNA rolls out).

**Escalation rule:** if an org is Safari-only (common in design teams),
that's a real blocker → Direct Tool connections (Plan B) evaluation,
not more support.

## 4. Quick reference — what to collect first (any issue)

1. `http://127.0.0.1:8765/health` output (or screenshot).
2. `http://127.0.0.1:8765/version` — bridge version + expected skill
   version (mismatch = stale skill, re-run setup_owui.py).
3. Browser + version, OS, install type (exe / service / script).
4. One line from the user: what they asked the AI, what came back.

The state dir holds the rest if needed (audit log, bridge log):
Linux `~/.local/state/file-bridge/`, Windows
`%APPDATA%\file-bridge\`, macOS `~/Library/Application Support/file-bridge/`.
