# Rclone recipe — bridge folder as a cloud drive

**Goal:** let the AI read/write files that live in Google Drive, OneDrive,
Dropbox, S3, or any of rclone's 70+ backends — **with zero bridge code**.
Open WebUI issue #5872 ("data sources: Drive/OneDrive/Dropbox/Notion
pickers", 52+ 👍) asks for exactly this; mounting an rclone remote as the
shared folder answers it locally, privately, and today.

**How it works:** the File Bridge only ever sees a normal local folder.
rclone presents the cloud drive as a filesystem mount at that path; every
`/read`, `/write`, `/pdf_text` … works unchanged. Files still never touch
the Open WebUI server — they flow browser → bridge → (rclone) → cloud.

> **Status: recipe, not lab-verified.** Written from rclone's documented
> mount behavior (v1.6x era). The dev machine has no rclone and no cloud
> remote; treat exact flags as "verify once on your platform". The
> architecture claim — bridge is mount-agnostic — follows from the design
> and IS verified (the bridge only does ordinary file I/O).

## 1. Install rclone + configure one remote

- Windows/macOS: <https://rclone.org/downloads/> (or `brew install rclone`,
  `winget install Rclone.Rclone`).
- Linux: `curl https://rclone.org/install.sh | sudo bash` or distro package.

Configure the backend once (interactive OAuth in a browser window):

```bash
rclone config            # n) new remote → name it e.g. "gdrive:"
                         # pick type → accept OAuth defaults → y
rclone lsd gdrive:       # smoke test: lists your Drive folders
```

For OneDrive/Dropbox/S3 the same wizard walks you through the provider's
own auth. Company Google Workspace accounts work; the OAuth consent screen
may need an admin allowlist ("rclone" app id) on locked-down tenants.

## 2. Mount the remote where the bridge can share it

Pick a mount point and mount it read-write (or `--read-only`, see §4):

```bash
# Linux (macOS similar; use /Volumes/gdrive)
mkdir -p ~/CloudDrive
rclone mount gdrive: ~/CloudDrive \
    --vfs-cache-mode writes \
    --dir-cache-time 30s \
    --vfs-cache-max-size 2G \
    --daemon

# Windows (needs WinFsp from https://winfsp.dev/ first)
rclone mount gdrive: C:\CloudDrive --vfs-cache-mode writes --vfs-cache-max-size 2G
```

Flags that matter for the bridge:

| Flag | Why |
|---|---|
| `--vfs-cache-mode writes` | REQUIRED for office writes. Without it rclone mounts read-mostly: random-seek writes (docx/xlsx are zip archives) fail or corrupt. `writes` stages changes on local disk and uploads in background. |
| `--dir-cache-time 30s` | The model lists a folder, then reads a file someone just dropped in the cloud. 30s keeps surprises rare without hammering the API. |
| `--vfs-cache-max-size 2G` | Office files + PDFs + OCR rasters can churn; cap the staging area. |
| `--daemon` (Linux/macOS) | Survives the terminal. For boot-time: `--rc` + a systemd unit / Windows service / LaunchAgent (see rclone docs "Installing as service"). |

## 3. Point the File Bridge at the mount

Two options — both supported by the bridge's normal folder flow:

**a) Make the mount a shared root.** Open `http://127.0.0.1:8765` →
settings → add folder → select `~/CloudDrive`. From then on `/list`,
`/read`, `/write`, `/ocr`, `/convert` … all operate on Drive content.

**b) Whole-bridge default.** Start the bridge with the mount as its root
argument (installer / service config), same as any local folder.

Prefer (a): the mount stays one root among several, and the per-root
read-only toggle gives an easy "AI may look but not touch my Drive" mode.

## 4. Behavior notes you'll hit within a week

- **First read of a big file is slow.** rclone downloads on demand; a
  40 MB PDF's first `/pdf_text` call pays the fetch. Subsequent reads hit
  the local cache. The bridge's 60 s HTTP timeout is the practical cap —
  huge scanned PDFs may be better opened via `/pdf_text?pages=1-5` windows.
- **Conflict semantics.** VFS mount + a colleague editing the same sheet
  in the cloud = last-writer-wins at upload time. The bridge's snapshot
  versions still fire (they capture the local pre-write state), but
  rclone is NOT a sync engine: for heavy multi-editor folders consider
  `rclone bisync` on a real local folder instead of a live mount.
- **`/write` latency.** Atomic-write (temp + rename) works fine over VFS
  with `writes` cache mode; the upload completes in the background AFTER
  the bridge reports success — a 200 means "cached locally", not "in the
  cloud". Watch `rclone ls gdrive:` (or the mount's `.uploading`
  behavior) if you need proof of upload.
- **Read-only mode.** Mount with `--read-only` AND/OR flip the root's
  read-only toggle in the bridge picker — belt and suspenders, the
  bridge refuses writes before rclone ever sees them.
- **Ignore lists still apply.** `.git/`, `*.tmp`, secrets patterns —
  all evaluated after the mount resolves, so they work identically.
- **Quota/lock errors from the cloud surface as 5xx.** The bridge wraps
  OS errors from the mounted path; a Google Drive rate-limit shows up as
  a generic read failure. Check `rclone`'s log (`--log-file`) for the
  real cause.

## 5. What NOT to do

- Don't mount with `--vfs-cache-mode off` — office-file writes WILL fail.
- Don't share the rclone **config file** (`~/.config/rclone/rclone.conf`,
  contains OAuth tokens) through the bridge. It lives outside the mount,
  and the bridge's sensitive-name floor would refuse it anyway — keep it
  that way.
- Don't use this for cloud folders with legal hold / immutability
  requirements without `--read-only`.

## 6. Uninstall / undo

```bash
fusermount -u ~/CloudDrive      # Linux (umount on macOS)
rclone config delete gdrive     # remove remote + local token
```

The bridge keeps working on whatever folders remain — removing the mount
just makes that root report missing (list it in the picker and delete it).
