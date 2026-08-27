#!/usr/bin/env python3
"""
File Bridge — single-file, stdlib-only local file service for Open WebUI.
No dependencies. Works with Python 3.8+. Package with PyInstaller for
double-click binaries on Windows/macOS/Linux.

Usage: python file_bridge.py [folder]      (default: ~/file-bridge-shared)
Then:  pick a folder at http://127.0.0.1:8765 (opens in browser)

Security model (v2, roadmap P0):
  Tier 1 (default): CORS origin lock. Only the configured Open WebUI origin
      may call the bridge from a browser. Set on first run via the picker.
  Tier 2 (opt-in):  org-wide bearer token (X-Bridge-Token header), set by
      the admin (installer / setup script / picker). Checked in addition.
  "Production mode" hard-fail: file endpoints refuse to serve while BOTH
      tiers are unconfigured — the local picker stays reachable so setup
      can be completed. (Stance adopted from Open Terminal v0.11.30.)

State lives in a per-OS state dir (env FILE_BRIDGE_STATE_DIR overrides):
  Linux: ~/.local/state/file-bridge   macOS: ~/Library/Application Support/file-bridge
  Windows: %APPDATA%\\file-bridge     (pattern: OpenWorker coworker/secrets.py)
  state.json    — root, ocr_lang, allowed_origin, token hash (0600)
  bridge-token  — plaintext token (0600, owner-only; never sent in responses)
"""
import base64
import binascii
import hashlib
import hmac
import http.server
import json
import os
import re
import secrets as _secrets
import shutil
import socketserver
import subprocess
import stat
import sys
import tempfile
import threading
import time
import webbrowser
from pathlib import Path
from urllib.parse import urlparse, parse_qs, unquote

PORT = 8765
MAX_LIST = 500
MAX_READ = 200_000      # chars (text)
MAX_BINARY = 8_000_000  # bytes (base64 endpoints)

VERSION = "2.0"

_IS_WINDOWS = sys.platform == "win32"


# ---------------------------------------------------------------- state dir

def state_dir() -> Path:
    """Per-OS state directory (pattern borrowed from OpenWorker secrets.py:
    env override > native app-data location)."""
    base = os.environ.get("FILE_BRIDGE_STATE_DIR")
    if base:
        p = Path(base).expanduser()
    elif _IS_WINDOWS:
        appdata = os.environ.get("APPDATA")
        p = Path(appdata) / "file-bridge" if appdata else Path.home() / ".file-bridge"
    elif sys.platform == "darwin":
        p = Path.home() / "Library" / "Application Support" / "file-bridge"
    else:
        p = Path.home() / ".local" / "state" / "file-bridge"
    p.mkdir(parents=True, exist_ok=True)
    return p


def _restrict_to_user(path: Path, *, is_dir: bool) -> None:
    """Owner-only permissions. POSIX: mode bits (0700/0600). Windows has no
    mode bits — strip inherited ACLs and grant the current user alone
    (best-effort; pattern from OpenWorker secrets.py)."""
    if _IS_WINDOWS:
        user = os.environ.get("USERNAME")
        if not user:
            return
        domain = os.environ.get("USERDOMAIN")
        account = f"{domain}\\{user}" if domain else user
        grant = f"{account}:(OI)(CI)F" if is_dir else f"{account}:F"
        try:
            subprocess.run(["icacls", str(path), "/inheritance:r", "/grant:r", grant],
                           capture_output=True, check=False)
        except OSError:
            pass
        return
    try:
        os.chmod(path, 0o700 if is_dir else 0o600)
    except OSError:
        pass


STATE_DIR = state_dir()
STATE_FILE = STATE_DIR / "state.json"
TOKEN_FILE = STATE_DIR / "bridge-token"

_STATE_LOCK = threading.RLock()  # reentrant: set_token holds it while calling _state_update


def _state_load() -> dict:
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _state_update(**kv) -> dict:
    """Merge-update state atomically (v1 lost keys by rewriting the whole
    file — e.g. save_root wiped a previously saved ocr_lang)."""
    with _STATE_LOCK:
        st = _state_load()
        st.update(kv)
        tmp = STATE_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(st, indent=2), encoding="utf-8")
        _restrict_to_user(tmp, is_dir=False)   # chmod BEFORE the rename
        os.replace(tmp, STATE_FILE)
        return st


# ------------------------------------------------- audit log (P2, JSONL)
# Every file-touching call gets one line in state_dir/audit.log: ts,
# endpoint, method, path, size, status + SECRET-SCRUBBED args. Pattern:
# openworker coworker/audit.py `_SECRET_KEYS` scrub. Append-only, 0600,
# best-effort (audit failure must never break serving). Not an API — the
# file is for the human owner; models can't read it (state dir is
# structurally outside every root).

AUDIT_FILE = STATE_DIR / "audit.log"
_AUDIT_LOCK = threading.Lock()
_AUDIT_MAX_BYTES = 5 * 1024 * 1024   # rotate to audit.log.1 once past 5 MB

_SECRET_KEYS = (
    "token", "secret", "password", "api_key", "apikey", "authorization",
    "access_token", "refresh_token", "bearer", "credential", "private_key",
)
_BODY_KEYS = ("content", "b64", "body", "text", "old_text", "new_text", "html")
_ARG_TRUNCATE = 200


def _audit_scrub(value):
    """Recursive copy with secrets → [redacted] and payload keys → size only."""
    if isinstance(value, dict):
        out = {}
        for k, v in value.items():
            lk = str(k).lower()
            if any(s in lk for s in _SECRET_KEYS):
                out[k] = "[redacted]"
            elif any(b == lk or lk.endswith("_" + b) for b in _BODY_KEYS):
                # never log file CONTENT — record shape, not bytes
                out[k] = f"<{type(v).__name__}:{len(v) if hasattr(v, '__len__') else '?'}>"
            else:
                out[k] = _audit_scrub(v)
        return out
    if isinstance(value, list):
        return [_audit_scrub(v) for v in value[:10]]
    if isinstance(value, str):
        s = value.replace("\n", "\\n")
        return s if len(s) <= _ARG_TRUNCATE else s[:_ARG_TRUNCATE - 3] + "..."
    return value


def audit_log(endpoint: str, *, method: str = "GET", path: str | None = None,
              args: dict | None = None, status: int = 200,
              size: int | None = None, **extra) -> None:
    rec = {"ts": round(time.time(), 3), "endpoint": endpoint, "method": method,
           "status": status}
    if path is not None:
        rec["path"] = path[-400:]
    if args:
        rec["args"] = _audit_scrub(args)
    if size is not None:
        rec["size"] = size
    rec.update(extra)
    line = json.dumps(rec, default=str, ensure_ascii=False)
    try:
        with _AUDIT_LOCK:
            if AUDIT_FILE.exists() and AUDIT_FILE.stat().st_size > _AUDIT_MAX_BYTES:
                # simple rotation: shift .1 → dropped, current → .1
                old = AUDIT_FILE.with_suffix(".log.1")
                try:
                    old.unlink()
                except OSError:
                    pass
                try:
                    AUDIT_FILE.rename(old)
                except OSError:
                    pass
            with open(AUDIT_FILE, "a", encoding="utf-8") as fh:
                fh.write(line + "\n")
            try:
                os.chmod(AUDIT_FILE, 0o600)
            except OSError:
                pass
    except Exception:
        pass  # audit is best-effort: never fail a user request over it


# ------------------------------------------------------------- token store

def _hash_token(tok: str) -> str:
    return "sha256:" + hashlib.sha256(tok.encode()).hexdigest()


def get_configured_token() -> str | None:
    """Plaintext token for internal checks only (env override > token file).
    NEVER returned in any HTTP response."""
    env = os.environ.get("FILE_BRIDGE_TOKEN")
    if env:
        return env
    try:
        t = TOKEN_FILE.read_text(encoding="utf-8").strip()
        # ignore stale token file if state has no matching hash
        if t and _state_load().get("token_hash") == _hash_token(t):
            return t
    except Exception:
        pass
    return None


def set_token(tok: str | None) -> bool:
    """Store (or clear) the org-wide token. Returns success."""
    with _STATE_LOCK:
        if tok:
            tok = tok.strip()
            if not 8 <= len(tok) <= 256:
                return False
            TOKEN_FILE.write_text(tok, encoding="utf-8")
            _restrict_to_user(TOKEN_FILE, is_dir=False)
            _state_update(token_hash=_hash_token(tok))
        else:
            TOKEN_FILE.unlink(missing_ok=True)
            _state_update(token_hash=None)
    return True


def generate_token() -> str:
    tok = _secrets.token_urlsafe(24)
    set_token(tok)
    return tok


# ---------------------------------------------------------- origin (tier 1)

def _normalize_origin(o: str) -> str | None:
    """scheme://host[:port] with default ports made explicit, or None."""
    try:
        u = urlparse(o.strip())
        if u.scheme not in ("http", "https") or not u.hostname:
            return None
        port = u.port or (443 if u.scheme == "https" else 80)
        return f"{u.scheme}://{u.hostname.lower()}:{port}"
    except Exception:
        return None


def get_allowed_origin() -> str | None:
    env = os.environ.get("FILE_BRIDGE_ALLOWED_ORIGIN")
    raw = env or _state_load().get("allowed_origin")
    return _normalize_origin(raw) if raw else None


def set_allowed_origin(o: str | None) -> tuple[bool, str | None]:
    """Validate + persist. Returns (ok, normalized)."""
    if not o:
        _state_update(allowed_origin=None)
        return True, None
    n = _normalize_origin(o)
    if not n:
        return False, None
    _state_update(allowed_origin=o.strip())
    return True, n


def _request_origin(headers) -> str | None:
    """Normalize the Origin header (empty/`null` → None)."""
    raw = headers.get("Origin")
    if not raw or raw.strip().lower() == "null":
        return None
    return _normalize_origin(raw)


# ------------------------------------------------------------ security gate

def security_mode() -> str:
    """'token+origin' | 'token' | 'origin' | 'UNLOCKED' (both tiers off)."""
    has_tok = get_configured_token() is not None
    has_org = get_allowed_origin() is not None
    if has_tok and has_org:
        return "token+origin"
    if has_tok:
        return "token"
    if has_org:
        return "origin"
    return "UNLOCKED"


def check_request(headers) -> tuple[bool, int | None, str]:
    """Gate for FILE endpoints (not the local picker).

    Returns (allowed, http_status_if_denied, reason).
      - production hard-fail: both tiers off → deny 503
      - token tier: token configured → every request must carry it (401)
      - origin tier: browser Origin must match when present (403);
        non-browser callers without Origin are served (local tools) —
        that residual risk is exactly what the token tier closes.
    """
    mode = security_mode()
    if mode == "UNLOCKED":
        return False, 503, ("bridge unlocked — open the File Bridge settings page "
                            "(picker) and set the allowed Open WebUI origin "
                            "(and optionally a token) before serving files")
    tok = get_configured_token()
    if tok:
        supplied = headers.get("X-Bridge-Token", "")
        if not supplied:
            supplied = ""
            auth = headers.get("Authorization", "")
            if auth.lower().startswith("bearer "):
                supplied = auth[7:]
        if not hmac.compare_digest(supplied.encode(), tok.encode()):
            return False, 401, "missing or invalid bridge token"
    allowed = get_allowed_origin()
    origin = _request_origin(headers)
    if allowed and origin and origin != allowed:
        return False, 403, (f"origin {origin} is not the configured Open WebUI "
                            f"origin")
    return True, None, ""


# ------------------------------------------------------------- add-on setup

# Wheel hosting: serve pure-Python wheels bundled next to this file in ./wheels/
# so Pyodide installs them from localhost instead of PyPI (fast + offline).
# (WHEELS_DIR is set after _app_dir() is defined, for frozen-build support)

# Optional PDF/OCR add-on. Two parts, each auto-detected:
#   PDF: `pip install pymupdf` (importable)          -> /pdf_text, + /ocr for PDFs
#   OCR: tesseract binary on PATH (or TESSERACT_CMD) -> /ocr
# Bridge stays fully functional without them; /health reports availability.
try:
    import fitz  # pymupdf
    HAVE_PYMUPDF = True
except ImportError:
    fitz = None
    HAVE_PYMUPDF = False


def _app_dir() -> Path:
    """Directory where the app's bundled assets live (wheels/, tessdata/,
    tesseract/). Under PyInstaller --onefile, __file__ points into a throwaway
    extraction dir, so frozen apps must use the executable's directory."""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def _find_tesseract():
    """Locate the tesseract binary. Order:
    1. TESSERACT_CMD env override
    2. bundled: <app>/tesseract/tesseract.exe      (Windows installer layout)
       or      <app>/tesseract/bin/tesseract        (unix layout)
    3. `tesseract` on PATH
    Returns (path, version_str) or (None, None)."""
    import shutil as _sh
    cands = []
    if os.environ.get("TESSERACT_CMD"):
        cands.append(os.environ["TESSERACT_CMD"])
    cands += [str(_app_dir() / "tesseract" / "tesseract.exe"),
              str(_app_dir() / "tesseract" / "bin" / "tesseract")]
    wh = _sh.which("tesseract")
    if wh:
        cands.append(wh)
    for cand in cands:
        if cand and os.path.isfile(cand) and os.access(cand, os.X_OK):
            try:
                out = subprocess.run([cand, "--version"], capture_output=True,
                                     text=True, timeout=10)
                ver = (out.stdout or out.stderr).splitlines()[0] if (out.stdout or out.stderr) else ""
                return cand, ver
            except Exception:
                continue
    return None, None


TESSERACT_BIN, TESSERACT_VER = _find_tesseract()
# tessdata dir override (bundled langs next to the app, or system default).
# Order: env TESSDATA_PREFIX > <app>/tessdata > <app>/tesseract/tessdata
# (bundled-engine layout) > tesseract compiled-in default.
_ad = _app_dir()
WHEELS_DIR = _ad / "wheels"
TESSDATA_DIR = (Path(os.environ["TESSDATA_PREFIX"]) if os.environ.get("TESSDATA_PREFIX")
                else _ad / "tessdata" if (_ad / "tessdata" / "eng.traineddata").exists()
                else _ad / "tesseract" / "tessdata" if (_ad / "tesseract" / "tessdata" / "eng.traineddata").exists()
                else None)  # None = let tesseract use its compiled-in default


def _ocr_langs_available():
    """List installed language codes from the active tessdata dir."""
    if TESSDATA_DIR and TESSDATA_DIR.is_dir():
        return sorted(f.stem for f in TESSDATA_DIR.glob("*.traineddata"))
    if TESSERACT_BIN:
        try:
            out = subprocess.run([TESSERACT_BIN, "--list-langs"],
                                 capture_output=True, text=True, timeout=10)
            langs = [l.strip() for l in (out.stdout or "").splitlines()[1:]
                     if l.strip() and ":" not in l]
            return langs
        except Exception:
            pass
    return []


def _get_ocr_lang():
    """Configured OCR language(s), e.g. 'swe+eng'. Saved in state file."""
    return _state_load().get("ocr_lang", "eng")


def _set_ocr_lang(lang: str):
    _state_update(ocr_lang=lang)


# ------------------------------------------------------------------- paths

def safe_child(base: Path, rel: str) -> Path:
    """Resolve rel under base with traversal protection (for tmp files)."""
    p = (base / rel).resolve()
    if os.path.commonpath([str(base.resolve()), str(p)]) != str(base.resolve()):
        raise PermissionError("path escapes allowed root")
    return p


def load_root():
    try:
        p = _state_load()["root"]
        p = Path(p)
        return p if p.is_dir() else None
    except Exception:
        return None


def save_root(p: Path):
    _state_update(root=str(p.resolve()))


def resolve_safe(root: Path, rel: str) -> Path:
    p = (root / rel).resolve()
    if os.path.commonpath([str(root.resolve()), str(p)]) != str(root.resolve()):
        raise PermissionError("path escapes shared root")
    return p


# ------------------------------------------- atomic writes (P2, temp+rename)
# A crash mid-write must never leave a torn file at a real path: write to a
# same-dir temp file, fsync, then os.replace (atomic on POSIX + Win on same
# volume). Final-path symlink protection: resolve_safe() rejects escape, but
# the LAST hop could still be a symlink swapped in after resolution — for
# overwrite targets we refuse to replace through one.

def atomic_write_bytes(target: Path, data: bytes, *, preserve_mode: bool = True):
    """Atomic binary write: same-dir tmp → fsync → chmod → os.replace."""
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.is_symlink():
        raise PermissionError("refusing to write through a symlink")
    mode = None
    if preserve_mode and target.exists():
        mode = stat.S_IMODE(target.stat().st_mode)
    fd, tmp = tempfile.mkstemp(dir=str(target.parent), prefix=".fb-tmp-")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(tmp, mode if mode is not None else 0o644)
        os.replace(tmp, target)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def atomic_write_text(target: Path, text: str, *, preserve_mode: bool = True):
    """Atomic text write (UTF-8). See atomic_write_bytes."""
    atomic_write_bytes(target, text.encode("utf-8"), preserve_mode=preserve_mode)


# ----------------------------------------------------- read safety (P0 #3)

# /read serves ONLY these extensions — fail-closed on anything else (unknown
# ext → 415 + hint to /peek). Stance validated by openworker readonly.py.
TEXT_EXTS = {
    ".txt", ".md", ".markdown", ".rst", ".csv", ".tsv", ".json", ".jsonl",
    ".xml", ".yml", ".yaml", ".toml", ".ini", ".cfg", ".conf", ".env",
    ".log", ".py", ".pyi", ".js", ".mjs", ".ts", ".jsx", ".tsx", ".html",
    ".htm", ".css", ".scss", ".less", ".svg", ".sql", ".sh", ".bash",
    ".zsh", ".fish", ".ps1", ".bat", ".cmd", ".make", ".mk", ".dockerfile",
    ".tex", ".srt", ".vtt", ".sub", ".c", ".h", ".cpp", ".hpp", ".cc",
    ".java", ".rs", ".go", ".rb", ".php", ".pl", ".pm", ".lua", ".r",
    ".swift", ".kt", ".kts", ".scala", ".vue", ".svelte", ".diff", ".patch",
}
# Extension-less files that are safely text (unix conventions).
KNOWN_BASENAMES = {
    "makefile", "dockerfile", "license", "licence", "readme", "changelog",
    "contributing", "authors", "notice", "codeowners", ".gitignore",
    ".gitattributes", ".dockerignore", ".editorconfig", ".env", ".npmrc",
    ".gitmodules",
}
OFFICE_ZIP_EXTS = {".docx", ".xlsx", ".pptx", ".odt", ".ods", ".odp", ".epub"}

# magic-byte signatures → coarse kind (checked BEFORE the extension whitelist:
# a .txt that is really a PNG gets rejected with the right routing hint)
_MAGIC = [
    (b"%PDF-", "pdf"),
    (b"PK\x03\x04", "zip"), (b"PK\x05\x06", "zip"), (b"PK\x07\x08", "zip"),
    (b"\x89PNG", "image"), (b"\xff\xd8\xff", "image"), (b"GIF87a", "image"),
    (b"GIF89a", "image"), (b"BM", "image"), (b"II*\x00", "image"),
    (b"MM\x00*", "image"), (b"RIFF", "binary"), (b"\x7fELF", "binary"),
    (b"MZ", "binary"), (b"\xca\xfe\xba\xbe", "binary"),
    (b"SQLite format 3\x00", "binary"), (b"OggS", "binary"),
    (b"fLaC", "binary"), (b"ID3", "binary"), (b"\x1f\x8b", "binary"),
    (b"\xfd7zXZ\x00", "binary"), (b"BZh", "binary"),
]


def sniff_kind(head: bytes):
    for sig, kind in _MAGIC:
        if head.startswith(sig):
            return kind
    return None


def _routing_hint(kind: str, ext: str) -> str:
    if kind == "pdf":
        return "PDF detected — use /pdf_text (text layer) or /ocr (scanned)"
    if kind == "zip" and ext in OFFICE_ZIP_EXTS:
        return (f"{ext} is a zip-based Office file — use /read_b64 and the "
                f"Pyodide office stack (see skill)")
    if kind == "zip":
        return "zip archive — use /read_b64 (Pyodide can open it via zipfile)"
    if kind == "image":
        return "image file — use /ocr (for text in it) or /read_b64"
    return "binary file — /read_b64 if you truly need the bytes"


# /read windowing (pattern: openworker coworker/tools/files.py)
DEFAULT_MAX_LINES = 2000
MAX_LINE_CHARS = 500


def _windowed_read(p: Path, start_line: int, max_lines: int) -> dict:
    start = start_line if start_line > 0 else 1
    n = max_lines if max_lines > 0 else DEFAULT_MAX_LINES
    n = min(n, DEFAULT_MAX_LINES)
    selected, total, budget = [], 0, MAX_READ
    with open(p, "r", encoding="utf-8", errors="replace") as fh:
        for i, line in enumerate(fh, 1):
            total = i
            if i < start or len(selected) >= n:
                continue
            text = line.rstrip("\n")
            if len(text) > MAX_LINE_CHARS:
                text = text[:MAX_LINE_CHARS] + "… (line truncated)"
            if budget - (len(text) + 8) < 0:  # overall char backstop
                selected.append(f"{i:>6}\t…(char budget reached — narrow the window)")
                budget = -1
                break
            budget -= len(text) + 8
            selected.append(f"{i:>6}\t{text}")
    end = start + len(selected) - 1 if selected else start - 1
    out = {
        "path": str(p.name), "start_line": start, "end_line": end,
        "total_lines": total, "content": "\n".join(selected),
    }
    if end < total:
        out["note"] = (f"showing lines {start}-{end} of {total}; "
                       f"call again with start_line={end + 1} to continue")
    return out


# ------------------------------------------------- versions + confirmations

CONFIRM_TTL_SECONDS = 60
_CONFIRM_FILE = STATE_DIR / "pending-confirmations.json"
_CONFIRM_LOCK = threading.Lock()

# writes that hit an EXISTING target snapshot it first (P0/P0b: 'makes model
# edits reversible'). Versions live OUTSIDE all roots — structurally
# unreachable via the path resolver (user decision 2026-08-27).
VERSIONS_DIR = STATE_DIR / "versions"


def _root_key(root: Path) -> str:
    return hashlib.sha256(str(root).encode()).hexdigest()[:12]


def _versions_root_for(root: Path) -> Path:
    d = VERSIONS_DIR / _root_key(root)
    return d


def snapshot_before_write(root: Path, target: Path) -> dict | None:
    """Copy current contents to versions store (root-hash scoped). Returns
    metadata or None (new file / unreadable). Cap: 8 MB per snapshot,
    512 MB total store (oldest pruned)."""
    try:
        if not target.is_file():
            return None
        size = target.stat().st_size
        if size > MAX_BINARY:
            return {"skipped": "too_large", "size": size}
        ts = time.strftime("%Y%m%d-%H%M%S") + "-" + _secrets.token_hex(2)
        rel = target.relative_to(root).as_posix()
        vdir = _versions_root_for(root)
        dest_dir = vdir / ts / rel.lstrip("/")
        dest_dir.parent.mkdir(parents=True, exist_ok=True)
        _restrict_to_user(vdir, is_dir=True)
        shutil.copy2(target, dest_dir)
        # manifest entry (append-only JSONL, one line per snapshot)
        with open(vdir / "manifest.jsonl", "a", encoding="utf-8") as fh:
            fh.write(json.dumps({"ts": ts, "path": rel, "size": size,
                                 "snapshot": str(dest_dir)}) + "\n")
        _prune_versions(vdir)
        return {"ts": ts, "path": rel, "size": size}
    except Exception as e:
        return {"skipped": f"error: {e}"}


def _prune_versions(vdir: Path, max_bytes: int = 512 * 1024 * 1024):
    """Keep the store under ~max_bytes by dropping oldest snapshot dirs."""
    try:
        snaps = sorted((d for d in vdir.glob("*/") if d.is_dir()))
        total = sum(f.stat().st_size for d in snaps for f in d.rglob("*") if f.is_file())
        i = 0
        while total > max_bytes and i < len(snaps):
            sz = sum(f.stat().st_size for f in snaps[i].rglob("*") if f.is_file())
            shutil.rmtree(snaps[i], ignore_errors=True)
            total -= sz
            i += 1
    except Exception:
        pass


def versions_list(root: Path, rel_filter: str = "") -> list:
    """METADATA ONLY (path/ts/size) — contents are never served (user
    decision: old/removed content must not re-enter model reach)."""
    out = []
    mf = _versions_root_for(root) / "manifest.jsonl"
    try:
        for line in open(mf, encoding="utf-8").read().splitlines():
            try:
                e = json.loads(line)
            except Exception:
                continue
            if rel_filter and rel_filter not in e.get("path", ""):
                continue
            e["restore"] = "POST /versions/restore {path: %r, ts: %r}" % (e["path"], e["ts"])
            out.append(e)
    except FileNotFoundError:
        pass
    out.reverse()  # newest first
    return out[:200]


def version_restore(root: Path, rel: str, ts: str) -> tuple[bool, str]:
    """Restore = a write: snapshot-first if target exists now, then copy back."""
    vdir = _versions_root_for(root)
    snap_root = vdir / ts / rel.lstrip("/")
    if not snap_root.is_file():
        # search by ts + suffix (snapshot dirs embed the tree)
        cands = list((vdir / ts).rglob(snap_root.name))
        if len(cands) != 1:
            return False, f"no unique snapshot for {rel} @ {ts}"
        snap_root = cands[0]
    target = (root / rel).resolve()  # same-root guard done by caller
    if target.exists():
        snapshot_before_write(root, target)  # don't lose current state either
    target.parent.mkdir(parents=True, exist_ok=True)
    # verified copy-then-rename (snapshot store may be another filesystem)
    fd, tmp = tempfile.mkstemp(dir=str(target.parent), prefix=".fb-restore-")
    os.close(fd)
    shutil.copy2(snap_root, tmp)
    os.chmod(tmp, stat.S_IMODE(snap_root.stat().st_mode))
    os.replace(tmp, target)
    return True, str(target)


# ---- two-step confirmation tokens (pattern: openapi-servers filesystem) ----

def _confirm_load() -> dict:
    try:
        data = json.loads(_CONFIRM_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}
    now = time.time()
    out = {}
    for tok, det in data.items():
        try:
            if float(det["expiry"]) > now:
                out[tok] = det
        except Exception:
            continue
    return out


def _confirm_save(data: dict):
    tmp = _CONFIRM_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(data), encoding="utf-8")
    _restrict_to_user(tmp, is_dir=False)
    os.replace(tmp, _CONFIRM_FILE)


def confirmation_issue(params: dict) -> dict:
    """Create a pending confirmation; returns the token payload (TTL 60 s)."""
    with _CONFIRM_LOCK:
        allc = _confirm_load()
        tok = _secrets.token_hex(4)  # 8 hex chars — relayed via chat
        allc[tok] = {"params": params, "expiry": time.time() + CONFIRM_TTL_SECONDS}
        _confirm_save(allc)
    return {"confirmation_token": tok,
            "expires_in": CONFIRM_TTL_SECONDS}


def confirmation_consume(tok: str, params: dict) -> tuple[bool, str]:
    """Validate token + params match. The token is burned on ANY consume
    attempt — mismatch included (stricter than the openapi-servers original,
    which allowed retries: a mismatch means the model changed its request)."""
    with _CONFIRM_LOCK:
        allc = _confirm_load()
        det = allc.pop(tok, None)
        _confirm_save(allc)
        if not det:
            return False, "invalid or expired confirmation token"
        if det["params"] != params:
            return False, ("request parameters do not match the original request "
                           "for this token (token consumed — request a new one)")
        return True, ""






# -------------------------------------------------- result cache (P2)
# /pdf_text + /ocr are the expensive endpoints (raster + tesseract ≈ 1s per
# page). History replays and chat re-asks hit the same file+params over and
# over — cache the computed result keyed by (sha256(content), op+params).
# Pattern: openworker coworker/pdf_support.py `_cached` LRU.

_CACHE: dict[tuple, dict] = {}
_CACHE_MAX = 16          # entries (each entry = one full result doc)
_CACHE_LOCK = threading.Lock()


def _file_digest(p: Path) -> str | None:
    try:
        h = hashlib.sha256()
        with open(p, "rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                h.update(chunk)
        return h.hexdigest()
    except OSError:
        return None


def _cache_key(p: Path, op: str, params: dict) -> tuple | None:
    d = _file_digest(p)
    if d is None:
        return None
    return (d, op, json.dumps(params, sort_keys=True, default=str))


def cache_get(p: Path, op: str, params: dict):
    """Returns (hit, value). hit=False → compute, then cache_put()."""
    key = _cache_key(p, op, params)
    if key is None:
        return False, None
    with _CACHE_LOCK:
        val = _CACHE.get(key)
        return val is not None, val


def cache_put(p: Path, op: str, params: dict, value: dict) -> None:
    key = _cache_key(p, op, params)
    if key is None:
        return
    with _CACHE_LOCK:
        if len(_CACHE) >= _CACHE_MAX and key not in _CACHE:
            _CACHE.pop(next(iter(_CACHE)))   # FIFO eviction, openworker-style
        _CACHE[key] = value


def cache_stats() -> dict:
    with _CACHE_LOCK:
        return {"entries": len(_CACHE), "max": _CACHE_MAX}


# ------------------------------------------------- office reads (P1)

# Optional native readers; stdlib zipfile+XML fallbacks keep the bridge
# dependency-free (same pattern as the pymupdf add-on).
try:
    import openpyxl
    HAVE_OPENPYXL = True
except ImportError:
    openpyxl = None
    HAVE_OPENPYXL = False


def _cell_ref_to_idx(ref: str):
    """'B3' -> (col_idx_1based, row_idx_1based)."""
    import re as _r
    m = _r.match(r"([A-Z]+)([0-9]+)", ref.strip().upper())
    if not m:
        return None
    col = 0
    for ch in m.group(1):
        col = col * 26 + (ord(ch) - 64)
    return col, int(m.group(2))


def _xlsx_read_stdlib(path: Path, sheet: str | None, rng: str | None, max_rows: int):
    """Minimal xlsx reader: sharedStrings + sheet XML -> grid."""
    import zipfile
    import xml.etree.ElementTree as ET
    NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
    out = {"engine": "stdlib-xml"}
    with zipfile.ZipFile(path) as z:
        # shared strings
        shared = []
        if "xl/sharedStrings.xml" in z.namelist():
            root = ET.fromstring(z.read("xl/sharedStrings.xml"))
            for si in root.findall(f"{NS}si"):
                shared.append("".join(t.text or "" for t in si.iter(f"{NS}t")))
        # workbook sheet map
        wb = ET.fromstring(z.read("xl/workbook.xml"))
        sheets = [{"name": sh.get("name"),
                   "rid": sh.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id")}
                  for sh in wb.iter(f"{NS}sheet")]
        rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
        relmap = {r.get("Id"): r.get("Target") for r in rels}
        target_sheet = None
        if sheet:
            for sh in sheets:
                if sh["name"] == sheet:
                    target_sheet = sh
                    break
            if not target_sheet:
                return {"error": f"no such sheet: {sheet}", "sheets": [s["name"] for s in sheets]}
        else:
            target_sheet = sheets[0] if sheets else None
        if not target_sheet:
            return {"error": "workbook has no sheets"}
        t = relmap.get(target_sheet["rid"], "")
        t = t.lstrip("/")
        if not t.startswith("xl/"):
            t = "xl/" + t
        # absolute rel targets ("/xl/worksheets/...") and "worksheets/..." both
        # normalize to "xl/worksheets/..." — never double-prefix
        out["sheet"] = target_sheet["name"]
        out["sheets"] = [s["name"] for s in sheets]
        ws = ET.fromstring(z.read(t))
        # merged cells
        merged = [mc.get("ref") for mc in ws.iter(f"{NS}mergeCell")]
        out["merged_cells"] = merged[:200]
        # range bounds
        col_a = row_a = 1
        col_b = row_b = None
        if rng:
            try:
                a, b = rng.split(":")
                ca, ra = _cell_ref_to_idx(a)
                cb, rb = _cell_ref_to_idx(b)
                col_a, row_a, col_b, row_b = ca, ra, cb, rb
            except Exception:
                return {"error": f"bad range: {rng} (want A1:C10)"}
        rows_out, nrow = [], 0
        for row in ws.iter(f"{NS}row"):
            ri = int(row.get("r") or len(rows_out) + 1)
            if ri < row_a:
                continue
            if row_b and ri > row_b:
                break
            if nrow >= max_rows:
                out["truncated"] = True
                break
            cells = {}
            for c in row.findall(f"{NS}c"):
                ref = c.get("r") or ""
                t = c.get("t")
                v = c.find(f"{NS}v")
                is_el = c.find(f"{NS}is")
                if t == "s" and v is not None:
                    val = shared[int(v.text)]
                elif t == "inlineStr" and is_el is not None:
                    val = "".join(x.text or "" for x in is_el.iter(f"{NS}t"))
                elif v is not None:
                    val = v.text
                    if val is not None:
                        try:
                            f = float(val)
                            val = int(f) if f == int(f) else f
                        except ValueError:
                            pass
                else:
                    continue
                idx = _cell_ref_to_idx(ref)
                if idx:
                    ci = idx[0]
                    if ci < col_a or (col_b and ci > col_b):
                        continue
                    cells[ci] = val
            if cells:
                width = max(cells) - col_a + 1
                rows_out.append([cells.get(col_a + i) for i in range(width)])
            else:
                rows_out.append([])
            nrow += 1
    while rows_out and not any(rows_out[-1]):
        rows_out.pop()
    out["row_count"] = len(rows_out)
    out["data"] = rows_out
    return out


def _xlsx_read(path: Path, q: dict):
    sheet = q.get("sheet") or None
    rng = q.get("range") or None
    max_rows = min(int(q.get("max_rows", "200") or 200), 5000)
    if HAVE_OPENPYXL:
        wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
        try:
            names = wb.sheetnames
            if sheet and sheet not in names:
                return {"error": f"no such sheet: {sheet}", "sheets": names}
            ws = wb[sheet] if sheet else wb.active
            out = {"engine": "openpyxl", "sheet": ws.title, "sheets": names,
                   "merged_cells": [str(m) for m in
                                    (ws.merged_cells.ranges if hasattr(ws, "merged_cells") else [])][:200]}
            col_a = row_a = 1
            col_b = row_b = None
            if rng:
                try:
                    a, b = rng.split(":")
                    ca, ra = _cell_ref_to_idx(a)
                    cb, rb = _cell_ref_to_idx(b)
                    col_a, row_a, col_b, row_b = ca, ra, cb, rb
                except Exception:
                    return {"error": f"bad range: {rng} (want A1:C10)"}
            rows_out = []
            for ri, row in enumerate(ws.iter_rows(), 1):
                if ri < row_a:
                    continue
                if row_b and ri > row_b:
                    break
                if len(rows_out) >= max_rows:
                    out["truncated"] = True
                    break
                vals = []
                for ci, cell in enumerate(row, 1):
                    if ci < col_a:
                        continue
                    if col_b and ci > col_b:
                        break
                    vals.append(cell.value)
                rows_out.append(vals)
            while rows_out and not any(v is not None for v in rows_out[-1]):
                rows_out.pop()
            out["row_count"] = len(rows_out)
            out["data"] = rows_out
            return out
        finally:
            wb.close()
    return _xlsx_read_stdlib(path, sheet, rng, max_rows)


def _docx_read(path: Path, q: dict):
    """python-docx if present, else stdlib XML walk → markdown-ish text."""
    import zipfile
    import xml.etree.ElementTree as ET
    W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
    out_lines = []
    with zipfile.ZipFile(path) as z:
        root = ET.fromstring(z.read("word/document.xml"))
        body = root.find(f"{W}body")
        for el in body.iter():
            if el.tag == f"{W}p":
                # heading?
                style = ""
                pPr = el.find(f"{W}pPr")
                if pPr is not None:
                    s = pPr.find(f"{W}pStyle")
                    if s is not None:
                        style = s.get(f"{W}val", "")
                text = "".join(t.text or "" for t in el.iter(f"{W}t")).strip()
                if not text:
                    continue
                sm = re.match(r"(?i)heading(\d)$", style) or re.match(r"(?i)titre(\d)$", style)
                if style.lower() == "title":
                    out_lines.append("# " + text)
                elif sm:
                    lvl = min(int(sm.group(1)), 6)
                    out_lines.append("#" * lvl + " " + text)
                elif style.startswith("List") or style == "BulletList":
                    out_lines.append("- " + text)
                else:
                    out_lines.append(text)
            elif el.tag == f"{W}tbl":
                # table: rows -> pipe rows
                rows = []
                for tr in el.findall(f"{W}tr"):
                    cells = []
                    for tc in tr.findall(f"{W}tc"):
                        cells.append("".join(t.text or "" for t in tc.iter(f"{W}t")).strip())
                    rows.append("| " + " | ".join(cells) + " |")
                if rows:
                    sep = "|" + "---|" * (rows[0].count("|") - 1)
                    rows.insert(1, sep)
                    out_lines.extend(rows)
    text = "\n".join(out_lines)
    max_chars = int(q.get("max_chars", "60000") or 60000)
    return {"path": q.get("path"), "chars": len(text),
            "truncated": len(text) > max_chars,
            "markdown": text[:max_chars]}


def _pptx_read(path: Path, q: dict):
    """Per-slide titles + text boxes via stdlib XML."""
    import zipfile
    import xml.etree.ElementTree as ET
    import re as _r
    A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
    slides = []
    with zipfile.ZipFile(path) as z:
        names = sorted((n for n in z.namelist()
                        if _r.fullmatch(r"ppt/slides/slide\d+\.xml", n)),
                       key=lambda n: int(_r.search(r"(\d+)", n).group(1)))
        for i, name in enumerate(names, 1):
            root = ET.fromstring(z.read(name))
            texts = []
            for p in root.iter(f"{A}p"):
                t = "".join(x.text or "" for x in p.iter(f"{A}t")).strip()
                if t:
                    texts.append(t)
            slides.append({"slide": i, "texts": texts,
                           "title": texts[0] if texts else None})
            if i >= 200:
                break
    return {"path": q.get("path"), "slide_count": len(slides), "slides": slides}






# ------------------------------------------------ search + edit (P1)

def _search(root: Path, cfg: dict, q: dict):
    """Cross-file grep with context lines, glob filter, exclusions,
    case-insensitivity (param design from openapi-servers /search_content)."""
    import fnmatch
    query = q.get("q", "")
    if not query:
        return {"error": "need q= search term"}
    glob_pat = q.get("glob") or "*"
    case_sensitive = q.get("case", "insensitive") == "sensitive"
    needle = query if case_sensitive else query.lower()
    ctx = min(int(q.get("context", "1") or 1), 5)
    max_matches = min(int(q.get("max", "50") or 50), 200)
    excl = [x for x in (q.get("exclude") or "").split(",") if x.strip()]
    pats = list(cfg.get("ignore", [])) + _global_ignore() + excl
    matches, scanned = [], 0
    for f in sorted(root.rglob("*")):
        if len(matches) >= max_matches:
            break
        if not f.is_file():
            continue
        rel = f.relative_to(root).as_posix()
        if not fnmatch.fnmatch(rel, glob_pat):
            continue
        if _ignore_match(rel, False, pats):
            continue
        if f.suffix.lower() not in TEXT_EXTS and f.name.lower() not in KNOWN_BASENAMES:
            continue  # text files only (binary grep = noise)
        try:
            lines = f.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            continue
        scanned += 1
        for i, line in enumerate(lines):
            hay = line if case_sensitive else line.lower()
            if needle in hay:
                lo, hi = max(0, i - ctx), min(len(lines), i + ctx + 1)
                matches.append({
                    "path": rel, "line": i + 1,
                    "context": [f"{j+1}: {lines[j][:MAX_LINE_CHARS]}"
                                for j in range(lo, hi)],
                })
                if len(matches) >= max_matches:
                    break
    return {"query": query, "scanned_files": scanned, "matches": matches,
            "truncated": len(matches) >= max_matches}


def _edit_file(root: Path, cfg: dict, body: dict, confirm_func):
    """Surgical replacements with dry-run unified diff (pattern:
    openapi-servers /edit_file). Applies via the standard write path
    (snapshot + confirmation) — never a raw overwrite."""
    import difflib
    rel = body.get("path", "")
    if not rel:
        return 400, {"error": "need path"}
    p, _root, _cfg = resolve_guarded(unquote(rel), for_write=True)
    if not p.is_file():
        return 404, {"error": f"no such file: {rel}"}
    if p.suffix.lower() not in TEXT_EXTS and p.name.lower() not in KNOWN_BASENAMES:
        return 415, {"error": "/edit is for text files (see /read whitelist)"}
    if _readonly_for(cfg):
        return 403, {"error": "read-only mode is active"}
    edits = body.get("edits", [])
    if not isinstance(edits, list) or not edits:
        return 400, {"error": "need edits: [{old_text, new_text}, ...]"}
    original = p.read_text(encoding="utf-8", errors="replace")
    modified = original
    for e in edits:
        old, new = e.get("old_text", ""), e.get("new_text", "")
        count = e.get("count", 1)
        if old not in modified:
            return 400, {"error": f"old_text not found: {old[:60]!r}"}
        modified = modified.replace(old, new, int(count) if count else -1)
    if body.get("dry_run"):
        diff = "".join(difflib.unified_diff(
            original.splitlines(keepends=True),
            modified.splitlines(keepends=True),
            fromfile=f"a/{rel}", tofile=f"b/{rel}"))
        return 200, {"dry_run": True, "diff": diff,
                     "changed": modified != original}
    # real write: same guarded path as /write (confirmation + snapshot)
    code, resp = confirm_func({"op": "edit", "path": rel,
                               "bytes": len(modified)})
    if code:
        return code, resp
    return 200, {"ok": True, "path": rel, "edited": modified != original}


def _html_text(path: Path, q: dict):
    from html.parser import HTMLParser

    class Extractor(HTMLParser):
        SKIP = {"script", "style", "noscript", "head", "meta", "title"}
        BLOCK = {"p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5",
                 "h6", "section", "article", "table", "ul", "ol"}

        def __init__(self):
            super().__init__()
            self.parts = []
            self.skip_depth = 0

        def handle_starttag(self, tag, attrs):
            if tag in self.SKIP:
                self.skip_depth += 1
            elif tag in self.BLOCK and self.parts and not self.parts[-1].endswith("\n"):
                self.parts.append("\n")

        def handle_endtag(self, tag):
            if tag in self.SKIP and self.skip_depth:
                self.skip_depth -= 1
            elif tag in self.BLOCK:
                self.parts.append("\n")

        def handle_data(self, data):
            if not self.skip_depth and data.strip():
                self.parts.append(data)

    ex = Extractor()
    ex.feed(path.read_text(encoding="utf-8", errors="replace"))
    text = "".join(ex.parts)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    max_chars = int(q.get("max_chars", "60000") or 60000)
    return {"path": q.get("path"), "chars": len(text),
            "truncated": len(text) > max_chars, "text": text[:max_chars]}


def _csv_head_stats(path: Path, q: dict, want_stats: bool):
    import csv
    import io as _io
    nrows = min(int(q.get("rows", "20") or 20), 200)
    delim = q.get("delim") or ","
    if delim in ("tab", "\\t", "t"):
        delim = "\t"
    rows, widths = [], set()
    with open(path, newline="", encoding="utf-8", errors="replace") as fh:
        reader = csv.reader(fh, delimiter=delim)
        for i, row in enumerate(reader):
            widths.add(len(row))
            if i < nrows:
                rows.append(row)
    out = {"path": q.get("path"), "delimiter": delim,
           "ragged": len(widths) > 1, "widths": sorted(widths)[:10],
           "head": rows}
    if want_stats:
        with open(path, newline="", encoding="utf-8", errors="replace") as fh:
            all_rows = list(csv.reader(fh, delimiter=delim))
        total = len(all_rows)
        ncols = max(widths) if widths else 0
        cols = []
        for c in range(min(ncols, 100)):
            vals = [r[c] for r in all_rows if len(r) > c and r[c] != ""]
            nums = []
            for v in vals:
                try:
                    nums.append(float(v))
                except ValueError:
                    pass
            col = {"col": c, "non_empty": len(vals)}
            if nums and len(nums) >= max(1, len(vals) // 2):
                col["type"] = "numeric"
                col["min"] = min(nums)
                col["max"] = max(nums)
            else:
                col["type"] = "text"
                col["samples"] = vals[:3]
            cols.append(col)
        out.update({"row_count": total, "column_count": ncols, "columns": cols})
    return out




# ------------------------------------------- trash + write guards (P0b)

TRASH_DIR = STATE_DIR / "trash"
TRASH_PURGE_DAYS = 30

# ---- rate circuit breaker: max writes per rolling window ----
_WRITE_LOG_LOCK = threading.Lock()
_WRITE_LOG: list = []          # (monotonic_ts, nbytes)
RATE_MAX_WRITES = 20          # per 60 s window (env-tunable)
RATE_MAX_BYTES = 50 * 1024 * 1024


def _rate_limits():
    mw = os.environ.get("FILE_BRIDGE_MAX_WRITES")
    mb = os.environ.get("FILE_BRIDGE_MAX_WRITE_MB")
    return (int(mw) if mw and mw.isdigit() else RATE_MAX_WRITES,
            int(mb) * 1024 * 1024 if mb and mb.isdigit() else RATE_MAX_BYTES)


def rate_check(nbytes: int) -> tuple[bool, str]:
    """Record a prospective write; False when the rolling window is over
    budget. A runaway model hits the brake, not the folder."""
    now = time.monotonic()
    max_w, max_b = _rate_limits()
    with _WRITE_LOG_LOCK:
        global _WRITE_LOG
        _WRITE_LOG = [t for t in _WRITE_LOG if now - t[0] < 60]
        w_count = sum(1 for t in _WRITE_LOG if t[1] >= 0)
        w_bytes = sum(max(t[1], 0) for t in _WRITE_LOG)
        if w_count + 1 > max_w or w_bytes + nbytes > max_b:
            return False, (f"write-rate circuit breaker: {w_count} writes / "
                           f"{w_bytes // 1024} KiB in the last 60 s (limits "
                           f"{max_w} / {max_b // 1024 // 1024} MiB). STOP and ask "
                           f"the user to confirm the mass edit before continuing.")
        _WRITE_LOG.append((now, nbytes))
    return True, ""


def _readonly_for(cfg: dict) -> bool:
    if _is_readonly():
        return True
    return bool(cfg.get("readonly"))


def trash_store_for(root: Path) -> Path:
    d = TRASH_DIR / _root_key(root)
    d.mkdir(parents=True, exist_ok=True)
    _restrict_to_user(d, is_dir=True)
    return d


def trash_move(root: Path, target: Path) -> dict:
    """Move target into the trash store preserving the tree. Cross-device
    fallback: verified copy-then-unlink (user decision note in roadmap)."""
    rel = target.relative_to(root).as_posix()
    ts = time.strftime("%Y%m%d-%H%M%S") + "-" + _secrets.token_hex(2)
    dest = trash_store_for(root) / ts / rel.lstrip("/")
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.rename(target, dest)            # same device: atomic
    except OSError:
        if target.is_dir():
            shutil.copytree(target, dest)
            n_src = sum(1 for _ in target.rglob("*"))
            n_dst = sum(1 for _ in dest.rglob("*"))
            if n_src != n_dst:
                shutil.rmtree(dest, ignore_errors=True)
                raise RuntimeError("trash copy verification failed — aborting, "
                                   "original untouched")
            shutil.rmtree(target)
        else:
            shutil.copy2(target, dest)
            if dest.stat().st_size != target.stat().st_size:
                dest.unlink(missing_ok=True)
                raise RuntimeError("trash copy verification failed — aborting, "
                                   "original untouched")
            target.unlink()
    mf = trash_store_for(root) / "manifest.jsonl"
    with open(mf, "a", encoding="utf-8") as fh:
        fh.write(json.dumps({"ts": ts, "path": rel,
                             "type": "dir" if dest.is_dir() else "file",
                             "size": _tree_size(dest)}) + "\n")
    return {"ts": ts, "path": rel, "trashed_to": str(dest)}


def _tree_size(p: Path) -> int:
    try:
        return sum(f.stat().st_size for f in p.rglob("*") if f.is_file()) if p.is_dir() \
            else p.stat().st_size
    except OSError:
        return 0


def trash_purge(root: Path | None = None):
    """Drop entries older than TRASH_PURGE_DAYS (opportunistic, called on
    trash ops; manual purge = settings page only)."""
    import datetime
    cutoff = time.time() - TRASH_PURGE_DAYS * 86400
    bases = [trash_store_for(root)] if root else \
            [d for d in TRASH_DIR.glob("*/") if d.is_dir()]
    for base in bases:
        for snap in base.glob("*/"):
            try:
                if snap.stat().st_mtime < cutoff:
                    shutil.rmtree(snap, ignore_errors=True)
            except OSError:
                pass


def trash_list(root: Path, rel_filter: str = "") -> list:
    """METADATA ONLY — same never-re-enter-model-reach rule as versions."""
    out = []
    mf = trash_store_for(root) / "manifest.jsonl"
    try:
        for line in open(mf, encoding="utf-8").read().splitlines():
            try:
                e = json.loads(line)
            except Exception:
                continue
            if rel_filter and rel_filter not in e.get("path", ""):
                continue
            e["restore"] = "POST /trash/restore {path: %r, ts: %r}" % (e["path"], e["ts"])
            out.append(e)
    except FileNotFoundError:
        pass
    out.reverse()
    return out[:200]


def trash_restore(root: Path, rel: str, ts: str) -> tuple[bool, str]:
    src = trash_store_for(root) / ts / rel.lstrip("/")
    if not src.exists():
        cands = list((trash_store_for(root) / ts).rglob(Path(rel).name))
        if len(cands) != 1:
            return False, f"no unique trash entry for {rel} @ {ts}"
        src = cands[0]
    target = (root / rel).resolve()
    if os.path.commonpath([str(root), str(target)]) != str(root):
        return False, "restore target escapes root"
    if target.exists():
        return False, ("target exists — trash/restore refuses to overwrite; "
                       "delete or rename it first")
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.rename(src, target)
    except OSError:
        if src.is_dir():
            shutil.copytree(src, target)
            shutil.rmtree(src)
        else:
            shutil.copy2(src, target)
            src.unlink()
    return True, str(target)



# ------------------------------------------------------- multi-root (P0b)

class ExcludedPath(Exception):
    """Path matches an ignore pattern → endpoints return 404-with-hint
    (roadmap: 'excluded by settings'), writes are refused outright."""
    def __init__(self, pattern, rel):
        self.pattern, self.rel = pattern, rel
        super().__init__(
            f"'{rel}' is excluded by ignore settings (pattern: {pattern}); "
            f"ask the user to adjust File Bridge settings if this is intended")


def roots_config() -> list:
    """All configured roots. Legacy single-'root' state migrates on the fly."""
    st = _state_load()
    if isinstance(st.get("roots"), list) and st["roots"]:
        return st["roots"]
    r = st.get("root")
    if r:
        return [{"id": "main", "path": r, "alias": "main",
                 "enabled": True, "ignore": []}]
    return []


def enabled_roots() -> list:
    out = []
    for r in roots_config():
        if not r.get("enabled", True):
            continue
        p = Path(r.get("path", "")).expanduser()
        if not p.is_dir():
            continue  # fail-closed: unlocatable roots simply don't resolve
        out.append(r)
    return out


def _sanitize_root_entry(e: dict, i: int) -> dict:
    rid = str(e.get("id") or f"root{i}").strip().lower()
    rid = re.sub(r"[^a-z0-9_-]", "-", rid)[:32] or f"root{i}"
    path = str(e.get("path", "")).strip()
    return {"id": rid, "path": path,
            "alias": str(e.get("alias") or rid)[:64],
            "enabled": bool(e.get("enabled", True)),
            "ignore": [str(x) for x in (e.get("ignore") or [])][:200]}


def set_roots(entries: list) -> tuple[bool, str]:
    """Validate + persist the root list. Rejects: empty paths, dup ids,
    roots inside the bridge state dir (self-protection)."""
    if not isinstance(entries, list) or not entries:
        return False, "roots must be a non-empty list"
    cleaned, seen = [], set()
    for i, e in enumerate(entries):
        c = _sanitize_root_entry(e, i)
        p = Path(c["path"]).expanduser()
        if not c["path"]:
            return False, f"root {i}: empty path"
        if not p.is_dir():
            return False, f"root '{c['id']}': not a folder: {p}"
        rp = p.resolve()
        try:
            if os.path.commonpath([str(STATE_DIR), str(rp)]) == str(STATE_DIR):
                return False, "bridge state dir cannot live inside a shared root"
            if os.path.commonpath([str(rp), str(STATE_DIR)]) == str(rp):
                return False, "shared root cannot contain the bridge state dir"
        except ValueError:
            pass  # different drives (Windows)
        if c["id"] in seen:
            return False, f"duplicate root id: {c['id']}"
        seen.add(c["id"])
        c["path"] = str(rp)
        cleaned.append(c)
    _state_update(roots=cleaned, root=cleaned[0]["path"])  # root=key compat
    return True, ""


_ROOT_ID_RE = re.compile(r"^([a-z0-9_-]{1,32})(?:/|$)")


def resolve_any(rel: str):
    """Resolve a request path to (abs, root_path, root_cfg).

    Addressing: '<root-id>/sub/path' picks that root; anything else resolves
    under the FIRST enabled root (default). Unknown leading segment = ordinary
    subdirectory of the default root."""
    ros = enabled_roots()
    if not ros:
        raise PermissionError("no shared folder configured — open the File Bridge "
                              "settings page")
    rel = (rel or "").strip()
    if rel.startswith("/") or (len(rel) > 1 and rel[1] == ":"):
        raise PermissionError("absolute paths are not allowed — address files "
                              "relative to a shared root")
    rel = rel.lstrip("/").replace("\\", "/")
    cfg = ros[0]
    m = _ROOT_ID_RE.match(rel)
    if m and m.group(1) in {r["id"] for r in ros}:
        cfg = next(r for r in ros if r["id"] == m.group(1))
        rel = rel[m.end():]
    root = Path(cfg["path"]).resolve()
    p = (root / rel).resolve()
    if os.path.commonpath([str(root), str(p)]) != str(root):
        raise PermissionError("path escapes shared root")
    # symlink guard: no component of p may be a symlink (a link to a dir
    # INSIDE the same root still resolves inside, but mixed trust — refuse
    # uniformly; the model can address the real path instead)
    cur = root
    for comp in rel.split("/"):
        if not comp:
            continue
        cur = cur / comp
        if cur.is_symlink():
            raise PermissionError(f"symlink in path is not allowed: {comp}")
    return p, root, cfg


def _global_ignore() -> list:
    return [str(x) for x in (_state_load().get("ignore_global") or [])]


def _ignore_match(rel: str, is_dir: bool, patterns: list):
    """gitignore-style subset: 'dir/' dir-only, '/x' anchored to root,
    '*' within/across segments, '#' comments. A path is excluded if it OR
    ANY ancestor directory matches."""
    import fnmatch
    parts = [x for x in rel.split("/") if x]
    cands = ["/".join(parts[:i + 1]) for i in range(len(parts))]
    for pat in patterns:
        p = pat.strip()
        if not p or p.startswith("#"):
            continue
        dir_only = p.endswith("/")
        if dir_only:
            p = p[:-1]
        anchored = p.startswith("/")
        if anchored:
            p = p[1:]
        if not p:
            continue
        for i, cand in enumerate(cands):
            if i == len(cands) - 1 and dir_only and not is_dir:
                continue
            if fnmatch.fnmatch(cand, p):
                return pat
    return None


def resolve_guarded(rel: str, *, for_write: bool = False):
    """resolve_any + self-protection floor + ignore enforcement.
    Used by EVERY file endpoint (roadmap: enforcement lives in the BRIDGE)."""
    p, root, cfg = resolve_any(rel)
    # --- self-protection floor (P0b): bridge-owned files are never
    # accessible via the file API, in any mode, even when a root overlaps —
    # prevents 'one approved write quietly widens future permissions'.
    try:
        if os.path.commonpath([str(STATE_DIR), str(p)]) == str(STATE_DIR):
            raise PermissionError("bridge state/storage is never accessible via the file API")
    except ValueError:
        pass
    rel_in_root = p.relative_to(root).as_posix()
    if rel_in_root != ".":
        pats = list(cfg.get("ignore", [])) + _global_ignore()
        hit = _ignore_match(rel_in_root, p.is_dir(), pats)
        if hit:
            if for_write:
                raise ExcludedPath(hit, rel_in_root)
            raise ExcludedPath(hit, rel_in_root)
    return p, root, cfg


def _legacy_root() -> Path | None:
    ros = enabled_roots()
    return Path(ros[0]["path"]) if ros else None


# ------------------------------------------------------------------ server

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write(f"[bridge] {self.address_string()} {fmt % args}\n")

    # ---- CORS / auth plumbing ----

    def _add_matching_cors(self):
        """Emit CORS headers ONLY when the request origin matches the lock
        (or no lock is configured — picker/setup phase). v1 echoed `*`."""
        origin = _request_origin(self.headers)
        allowed = get_allowed_origin()
        if allowed is None or (origin and origin == allowed):
            self.send_header("Access-Control-Allow-Origin", origin or "*")
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers",
                             "Content-Type, X-Bridge-Token, Authorization")
        # mismatched/foreign origins get NO CORS headers — the browser
        # refuses to expose the response even before our 403 body.

    def _json(self, code, obj, cors=True):
        body = json.dumps(obj).encode()
        if getattr(self, "_audit_ep", None):
            audit_log(self._audit_ep, method=self.command,
                      path=getattr(self, "_audit_path", None),
                      args=getattr(self, "_audit_args", None), status=code,
                      size=len(body))
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        if cors:
            self._add_matching_cors()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _audit(self, ep, path=None, args=None):
        """Mark this request for audit logging (idempotent per response)."""
        self._audit_ep = ep
        self._audit_path = path if path is None else str(path)
        self._audit_args = args

    def do_OPTIONS(self):
        self.send_response(204)
        self._add_matching_cors()
        self.send_header("Access-Control-Max-Age", "86400")
        self.end_headers()

    # ---- GET ----

    def do_GET(self):
        root = load_root()
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}

        if u.path == "/health":
            ros = [{"id": r["id"], "path": r["path"], "alias": r.get("alias")}
                   for r in enabled_roots()]
            info = {"ok": bool(ros), "roots": ros, "version": VERSION} if ros else \
                   {"ok": False, "hint": "no folder chosen yet",
                    "roots": [], "version": VERSION}
            if ros:
                info["root"] = ros[0]["path"]
            info["addons"] = {"pdf": HAVE_PYMUPDF, "ocr": bool(TESSERACT_BIN)}
            info["ocr_lang"] = _get_ocr_lang()
            info["ocr_langs_available"] = _ocr_langs_available()
            info["wheels"] = len(list(WHEELS_DIR.glob("*.whl"))) if WHEELS_DIR.is_dir() else 0
            mode = security_mode()
            info["security"] = mode
            info["locked"] = mode != "UNLOCKED"
            return self._json(200, info)

        if u.path == "/state":
            return self._json(200, {
                "root": str(root) if root else None,
                "roots": roots_config(), "port": PORT,
                "ocr_lang": _get_ocr_lang(),
                "allowed_origin": get_allowed_origin(),
                "security": security_mode(),
                "readonly": _is_readonly(),
                "ignore_global": _global_ignore(),
                "rate_limits": _rate_limits()})

        # ---- wheel hosting (token-free by design: static public wheels) ----
        if u.path == "/wheels":
            if WHEELS_DIR.is_dir():
                names = sorted(f.name for f in WHEELS_DIR.glob("*.whl"))
            else:
                names = []
            return self._json(200, {"wheels": names,
                                    "urls": [f"http://127.0.0.1:{PORT}/wheels/{n}" for n in names]})

        if u.path.startswith("/wheels/"):
            name = os.path.basename(unquote(u.path[len("/wheels/"):]))
            wf = (WHEELS_DIR / name).resolve()
            if os.path.commonpath([str(WHEELS_DIR), str(wf)]) != str(WHEELS_DIR) or not wf.is_file():
                return self._json(404, {"error": f"no such wheel: {name}"})
            data = wf.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self._add_matching_cors()
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return

        # ---- security gate: everything below serves files ----
        ok, status, reason = check_request(self.headers)
        if not ok:
            return self._json(status, {"error": reason})

        if root is None:
            return self._json(409, {"error": "No folder chosen. Open http://127.0.0.1:%d to pick one." % PORT})

        self._audit(u.path, path=unquote(q.get("path", "")) or None,
                    args={k: q[k] for k in q if k != "path"} or None)

        try:
            if u.path == "/list":
                p, root, cfg = resolve_guarded(unquote(q.get("path", ".")))
                if not p.is_dir():
                    return self._json(404, {"error": f"not a directory: {q.get('path')}"})
                entries = []
                pats = list(cfg.get("ignore", [])) + _global_ignore()
                for f in sorted(p.rglob("*")):
                    rel = f.relative_to(root).as_posix()
                    if _ignore_match(rel, f.is_dir(), pats):
                        continue
                    try:
                        st = f.stat()
                        entries.append({"path": rel, "type": "dir" if f.is_dir() else "file",
                                        "size": None if f.is_dir() else st.st_size,
                                        "mtime": int(st.st_mtime)})
                    except OSError:
                        continue
                    if len(entries) >= MAX_LIST:
                        break
                return self._json(200, {"root": str(root), "root_id": cfg.get("id"),
                                        "entries": entries})

            if u.path == "/read":
                p, root, cfg = resolve_guarded(unquote(q.get("path", "")))
                if not p.is_file():
                    return self._json(404, {"error": f"no such file: {q.get('path')}"})
                ext = p.suffix.lower()
                base = p.name.lower()
                if ext not in TEXT_EXTS and base not in KNOWN_BASENAMES and base != ".gitignore":
                    # fail-closed: unknown extension → refuse, offer /peek
                    return self._json(415, {
                        "error": f"/read is text-only; '.{ext.lstrip('.')}' is not on the "
                                 f"text whitelist (fail-closed)",
                        "hint": f"call /peek?path=…&bytes=512 to identify the file, or "
                                f"/read_b64 for raw bytes"})
                head = b""
                with open(p, "rb") as fh:
                    head = fh.read(16)
                kind = sniff_kind(head)
                if kind:
                    return self._json(415, {
                        "error": f"/read is text-only; this file sniffs as {kind}",
                        "hint": _routing_hint(kind, ext)})
                start_line = int(q.get("start_line", "1") or 1)
                max_lines = int(q.get("max_lines", str(DEFAULT_MAX_LINES)))
                out = _windowed_read(p, start_line, max_lines)
                out["path"] = q.get("path")
                return self._json(200, out)

            if u.path == "/peek":
                # identify a file cheaply: first bytes as preview + sniffing
                p, root, cfg = resolve_guarded(unquote(q.get("path", "")))
                if not p.is_file():
                    return self._json(404, {"error": f"no such file: {q.get('path')}"})
                nbytes = max(16, min(int(q.get("bytes", "512") or 512), 4096))
                with open(p, "rb") as fh:
                    head = fh.read(nbytes)
                kind = sniff_kind(head)
                ext = p.suffix.lower()
                guessed = kind or ("text" if ext in TEXT_EXTS or p.name.lower() in KNOWN_BASENAMES
                                   else "unknown")
                preview = head.decode("utf-8", errors="replace")
                preview = "".join(ch if ch.isprintable() or ch in "\n\r\t" else "·"
                                  for ch in preview)
                return self._json(200, {
                    "path": q.get("path"), "size": p.stat().st_size,
                    "ext": ext or None, "kind": guessed,
                    "printable_ratio": (sum(1 for b in head if 32 <= b < 127 or b in (9, 10, 13))
                                        / max(len(head), 1)),
                    "preview": preview,
                    "hint": _routing_hint(kind, ext) if kind else
                            ("looks like text — /read it" if guessed == "text" else
                             "unknown format — /read_b64 if you need the bytes"),
                })

            if u.path == "/read_b64":
                # binary-safe read: returns base64. For Office files, images,
                # PDFs. Capped at MAX_BINARY bytes.
                p, root, cfg = resolve_guarded(unquote(q.get("path", "")))
                if not p.is_file():
                    return self._json(404, {"error": f"no such file: {q.get('path')}"})
                raw = p.read_bytes()
                if len(raw) > MAX_BINARY:
                    return self._json(413, {"error": f"file too large: {len(raw)} > {MAX_BINARY} bytes"})
                return self._json(200, {
                    "path": q.get("path"),
                    "size": len(raw),
                    "b64": base64.b64encode(raw).decode("ascii"),
                })

            if u.path == "/stat":
                p, root, cfg = resolve_guarded(unquote(q.get("path", "")))
                if not p.exists():
                    return self._json(404, {"error": f"not found: {q.get('path')}"})
                st = p.stat()
                ext = p.suffix.lower()
                kind = ("image" if ext in {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"}
                        else "pdf" if ext == ".pdf"
                        else "zip" if ext in {".docx", ".xlsx", ".pptx", ".odt", ".ods", ".odp"}
                        else "legacy" if ext in {".doc", ".xls", ".ppt"}
                        else "text" if ext in {".txt", ".md", ".csv", ".json", ".xml", ".yml", ".yaml", ".log", ".py", ".js", ".html", ".css"}
                        else "other")
                return self._json(200, {
                    "path": q.get("path"), "size": st.st_size,
                    "mtime": int(st.st_mtime), "kind": kind, "ext": ext or None,
                })

            # ---------- optional PDF/OCR add-on endpoints ----------

            if u.path == "/pdf_text":
                # Extract embedded text layer from a PDF (pymupdf).
                if not HAVE_PYMUPDF:
                    return self._json(501, {"error": "PDF add-on not installed on this machine "
                                                     "(pip install pymupdf)"})
                p, root, cfg = resolve_guarded(unquote(q.get("path", "")))
                if not p.is_file():
                    return self._json(404, {"error": f"no such file: {q.get('path')}"})
                pages_param = q.get("pages", "")  # "1-3,5" optional, 1-indexed
                cache_params = {"pages": pages_param}
                hit, cached = cache_get(p, "pdf_text", cache_params)
                if hit:
                    return self._json(200, {**cached, "cached": True})
                doc = fitz.open(p)
                try:
                    total = doc.page_count
                    wanted = list(range(total))
                    if pages_param:
                        wanted = []
                        for part in pages_param.split(","):
                            part = part.strip()
                            if "-" in part:
                                a, b = part.split("-", 1)
                                wanted.extend(range(int(a) - 1, min(int(b), total)))
                            elif part:
                                wanted.append(int(part) - 1)
                        wanted = sorted(set(w for w in wanted if 0 <= w < total))
                    pages_out = []
                    char_budget = MAX_READ
                    for i in wanted:
                        txt = doc[i].get_text("text").strip()
                        pages_out.append({"page": i + 1, "text": txt})
                        char_budget -= len(txt)
                        if char_budget <= 0:
                            pages_out.append({"page": i + 1, "text": "…truncated (budget)"})
                            break
                    out = {"path": q.get("path"), "page_count": total,
                           "pages": pages_out}
                    cache_put(p, "pdf_text", cache_params, out)
                    return self._json(200, out)
                finally:
                    doc.close()

            if u.path == "/ocr":
                # OCR an image (png/jpg/bmp/webp/tiff) or a scanned PDF (per
                # page) using the tesseract binary. Language: request param
                # `lang` > saved setting (picker UI) > "eng".
                if not TESSERACT_BIN:
                    return self._json(501, {"error": "OCR unavailable: tesseract not "
                                                     "found. Install tesseract or set "
                                                     "TESSERACT_CMD."})
                p, root, cfg = resolve_guarded(unquote(q.get("path", "")))
                if not p.is_file():
                    return self._json(404, {"error": f"no such file: {q.get('path')}"})
                raw = q.get("lang") or _get_ocr_lang()
                # URL '+' decodes to space; treat space and ',' as separators
                parts = [p for p in re.split(r"[\s,+]+", raw) if p and re.fullmatch(r"[a-zA-Z_]{2,8}", p)]
                lang = "+".join(parts) if parts else "eng"
                ext = p.suffix.lower()
                max_pages = int(q.get("max_pages", "5"))
                dpi = q.get("dpi", "200")
                cache_params = {"lang": lang, "max_pages": max_pages, "dpi": dpi}
                hit, cached = cache_get(p, "ocr", cache_params)
                if hit:
                    return self._json(200, {**cached, "cached": True})
                results = []
                tmpdir = tempfile.mkdtemp(prefix="fb-ocr-")

                def run_tesseract(img_path):
                    cmd = [TESSERACT_BIN, img_path, "stdout", "-l", lang,
                           "--dpi", dpi]
                    env = dict(os.environ)
                    if TESSDATA_DIR:
                        env["TESSDATA_PREFIX"] = str(TESSDATA_DIR)
                    r = subprocess.run(cmd, capture_output=True, text=True,
                                       timeout=120, env=env)
                    if r.returncode != 0:
                        raise RuntimeError(r.stderr.strip()[:300])
                    return [l for l in r.stdout.splitlines() if l.strip()]

                try:
                    if ext in {".png", ".jpg", ".jpeg", ".bmp", ".webp", ".tif", ".tiff"}:
                        lines = run_tesseract(str(p))
                        results.append({"page": 1, "lines": lines})
                    elif ext == ".pdf":
                        if not HAVE_PYMUPDF:
                            return self._json(501, {"error": "PDF OCR needs the PDF add-on "
                                                             "(pip install pymupdf)"})
                        doc = fitz.open(p)
                        try:
                            for i in range(min(doc.page_count, max_pages)):
                                pix = doc[i].get_pixmap(dpi=int(dpi))
                                tf = os.path.join(tmpdir, f"p{i}.png")
                                pix.save(tf)
                                lines = run_tesseract(tf)
                                results.append({"page": i + 1, "lines": lines})
                        finally:
                            doc.close()
                    else:
                        return self._json(400, {"error": f"OCR supports images and PDF, not {ext}"})
                finally:
                    shutil.rmtree(tmpdir, ignore_errors=True)
                out = {"path": q.get("path"), "lang": lang,
                       "pages": results}
                cache_put(p, "ocr", cache_params, out)
                return self._json(200, out)

            if u.path == "/search":
                base = unquote(q.get("path", "."))
                p, root, cfg = resolve_guarded(base)
                if not p.is_dir():
                    return self._json(400, {"error": f"not a directory: {base}"})
                return self._json(200, _search(p, cfg, q))

            if u.path == "/html_text":
                p, root, cfg = resolve_guarded(unquote(q.get("path", "")))
                if not p.is_file():
                    return self._json(404, {"error": f"no such file: {q.get('path')}"})
                if p.suffix.lower() not in {".html", ".htm"}:
                    return self._json(400, {"error": f"not html: {p.suffix}"})
                try:
                    return self._json(200, _html_text(p, q))
                except Exception as e:
                    return self._json(500, {"error": f"html parse failed: {e}"})

            if u.path == "/csv_head":
                p, root, cfg = resolve_guarded(unquote(q.get("path", "")))
                if not p.is_file():
                    return self._json(404, {"error": f"no such file: {q.get('path')}"})
                if p.suffix.lower() not in {".csv", ".tsv"}:
                    return self._json(400, {"error": f"not a csv: {p.suffix}"})
                return self._json(200, _csv_head_stats(p, q, want_stats=False))

            if u.path == "/csv_stats":
                p, root, cfg = resolve_guarded(unquote(q.get("path", "")))
                if not p.is_file():
                    return self._json(404, {"error": f"no such file: {q.get('path')}"})
                if p.suffix.lower() not in {".csv", ".tsv"}:
                    return self._json(400, {"error": f"not a csv: {p.suffix}"})
                return self._json(200, _csv_head_stats(p, q, want_stats=True))

            if u.path == "/xlsx_read":
                p, root, cfg = resolve_guarded(unquote(q.get("path", "")))
                if not p.is_file():
                    return self._json(404, {"error": f"no such file: {q.get('path')}"})
                if p.suffix.lower() not in {".xlsx", ".xlsm"}:
                    return self._json(400, {"error": f"not an xlsx: {p.suffix}"})
                try:
                    out = _xlsx_read(p, q)
                except Exception as e:
                    return self._json(500, {"error": f"xlsx parse failed: {e}",
                                            "hint": "file may be legacy .xls — ask the "
                                                    "user to convert to .xlsx"})
                return self._json(200, out)

            if u.path == "/docx_read":
                p, root, cfg = resolve_guarded(unquote(q.get("path", "")))
                if not p.is_file():
                    return self._json(404, {"error": f"no such file: {q.get('path')}"})
                if p.suffix.lower() != ".docx":
                    return self._json(400, {"error": f"not a docx: {p.suffix}"})
                try:
                    out = _docx_read(p, q)
                except Exception as e:
                    return self._json(500, {"error": f"docx parse failed: {e}"})
                return self._json(200, out)

            if u.path == "/pptx_read":
                p, root, cfg = resolve_guarded(unquote(q.get("path", "")))
                if not p.is_file():
                    return self._json(404, {"error": f"no such file: {q.get('path')}"})
                if p.suffix.lower() != ".pptx":
                    return self._json(400, {"error": f"not a pptx: {p.suffix}"})
                try:
                    out = _pptx_read(p, q)
                except Exception as e:
                    return self._json(500, {"error": f"pptx parse failed: {e}"})
                return self._json(200, out)

            if u.path == "/ocr/config":
                # GET: current OCR settings + available langs. POST via /api/root.
                return self._json(200, {
                    "lang": _get_ocr_lang(),
                    "available": _ocr_langs_available(),
                    "engine": TESSERACT_VER or "tesseract",
                })

        except ExcludedPath as e:
            return self._json(404, {"error": str(e), "excluded": True,
                                    "hint": "excluded by settings — ask the user "
                                            "to adjust File Bridge settings"})
        except PermissionError as e:
            return self._json(400, {"error": str(e)})
        except Exception as e:
            return self._json(500, {"error": str(e)})
        return self._json(404, {"error": "unknown endpoint"})

    # ---- POST ----

    def do_POST(self):
        u = urlparse(self.path)

        # /api/root is the LOCAL picker API — loopback only, no bridge token
        # (the picker is how you set the token in the first place).
        if u.path == "/api/root":
            if not self._is_loopback():
                return self._json(403, {"error": "picker API is local only"}, cors=False)
            return self._do_api_root()

        root = load_root()
        ok, status, reason = check_request(self.headers)
        if not ok:
            return self._json(status, {"error": reason})
        if root is None:
            return self._json(409, {"error": "No folder chosen yet."})
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length) or b"{}")
            # audit BEFORE handling: one line per call, scrubbed in _json
            self._audit(u.path, path=unquote(str(body.get("path", ""))) or None,
                        args={k: body[k] for k in body
                              if k not in ("path", "content", "b64")} or None)
            if u.path == "/write":
                p, root, cfg = resolve_guarded(unquote(body.get("path", "")), for_write=True)
                content = body.get("content", "")
                confirm_token = body.get("confirmation_token")
                confirm_params = {"op": "write", "path": body.get("path", ""),
                                  "bytes": len(content)}
                if p.exists() and p.is_file() and not confirm_token:
                    # destructive overwrite → two-step confirmation (60 s)
                    iss = confirmation_issue(confirm_params)
                    return self._json(409, {
                        "error": "target exists — overwrite needs confirmation",
                        "confirmation_required": True,
                        "confirm_op": ("reply to the user with the token; re-send the "
                                       "SAME write with confirmation_token set after "
                                       "the user approves"),
                        **iss})
                if confirm_token:
                    okc, err = confirmation_consume(confirm_token, confirm_params)
                    if not okc:
                        return self._json(400, {"error": err})
                if _readonly_for(cfg):
                    return self._json(403, {"error": "read-only mode is active — "
                                                     "writes are disabled"})
                okr, err = rate_check(len(content))
                if not okr:
                    return self._json(429, {"error": err, "rate_limited": True,
                                            "hint": "relay this to the user and wait "
                                                    "for their confirmation"})
                snap = snapshot_before_write(root, p) if p.exists() else None
                atomic_write_text(p, content)
                return self._json(200, {"ok": True, "written": str(p), "bytes": len(content),
                                        "snapshot": snap})

            if u.path == "/write_b64":
                # binary-safe write: takes base64. For Office/PDF/image files.
                p, root, cfg = resolve_guarded(unquote(body.get("path", "")), for_write=True)
                try:
                    raw = base64.b64decode(body.get("b64", ""), validate=True)
                except (binascii.Error, ValueError) as e:
                    return self._json(400, {"error": f"invalid base64: {e}"})
                if len(raw) > MAX_BINARY:
                    return self._json(413, {"error": f"payload too large: {len(raw)} > {MAX_BINARY} bytes"})
                confirm_token = body.get("confirmation_token")
                confirm_params = {"op": "write_b64", "path": body.get("path", ""),
                                  "bytes": len(raw)}
                if p.exists() and p.is_file() and not confirm_token:
                    iss = confirmation_issue(confirm_params)
                    return self._json(409, {
                        "error": "target exists — overwrite needs confirmation",
                        "confirmation_required": True, **iss})
                if confirm_token:
                    okc, err = confirmation_consume(confirm_token, confirm_params)
                    if not okc:
                        return self._json(400, {"error": err})
                if _readonly_for(cfg):
                    return self._json(403, {"error": "read-only mode is active — "
                                                     "writes are disabled"})
                okr, err = rate_check(len(raw))
                if not okr:
                    return self._json(429, {"error": err, "rate_limited": True,
                                            "hint": "relay this to the user and wait "
                                                    "for their confirmation"})
                snap = snapshot_before_write(root, p) if p.exists() else None
                atomic_write_bytes(p, raw)
                return self._json(200, {"ok": True, "written": str(p), "bytes": len(raw),
                                        "snapshot": snap})

            if u.path == "/edit":
                _ep, _er, cfg = resolve_guarded(unquote(body.get("path", "")), for_write=True)
                def _confirm_edit(confirm_params):
                    # returns (http_code_or_0, resp) — mirrors /write flow
                    tok = body.get("confirmation_token")
                    if not tok:
                        iss = confirmation_issue(confirm_params)
                        return 409, {"error": "edit needs confirmation",
                                     "confirmation_required": True, **iss}
                    okc, err = confirmation_consume(tok, confirm_params)
                    if not okc:
                        return 400, {"error": err}
                    return 0, {}

                code, resp = _edit_file(root, cfg, body, _confirm_edit)
                if code >= 400 or resp.get("dry_run"):
                    return self._json(code, resp)
                # apply: snapshot + write via the guarded helper
                p, root, cfg = resolve_guarded(unquote(body.get("path", "")), for_write=True)
                edits = body.get("edits", [])
                modified = p.read_text(encoding="utf-8", errors="replace")
                for e in edits:
                    modified = modified.replace(e.get("old_text", ""),
                                                e.get("new_text", ""),
                                                int(e.get("count", 1) or 1) if e.get("count") else -1)
                okr, err = rate_check(len(modified))
                if not okr:
                    return self._json(429, {"error": err, "rate_limited": True})
                snap = snapshot_before_write(root, p)
                atomic_write_text(p, modified)
                return self._json(200, {"ok": True, "path": body.get("path"),
                                        "snapshot": snap})

            if u.path == "/versions/list":
                rel = body.get("path", "")
                rel = unquote(rel) if isinstance(rel, str) else ""
                _rp, _rr, _rc = resolve_guarded(rel or ".")
                return self._json(200, {"versions": versions_list(_rr, rel)})

            if u.path == "/versions/restore":
                rel = body.get("path", "")
                ts = str(body.get("ts", ""))
                if not rel or not ts:
                    return self._json(400, {"error": "need path + ts (from /versions/list)"})
                _rp, _rr, _rc = resolve_guarded(rel)
                rel = _rp.relative_to(_rr).as_posix()
                # restore is itself a write over an existing file → confirm
                confirm_token = body.get("confirmation_token")
                confirm_params = {"op": "restore", "path": rel, "ts": ts}
                if not confirm_token:
                    iss = confirmation_issue(confirm_params)
                    return self._json(409, {"error": "restore overwrites the current file — "
                                                     "needs confirmation",
                                            "confirmation_required": True, **iss})
                okc, err = confirmation_consume(confirm_token, confirm_params)
                if not okc:
                    return self._json(400, {"error": err})
                okr, mes = version_restore(_rr, rel, ts)
                if not okr:
                    return self._json(404, {"error": mes})
                return self._json(200, {"ok": True, "restored": mes})

            if u.path == "/delete":
                # NO unlink ever: delete = move to trash (structural isolation
                # outside all roots). Two-step confirmation like overwrites.
                rel = body.get("path", "")
                if not rel:
                    return self._json(400, {"error": "need path"})
                p, root, cfg = resolve_guarded(unquote(rel), for_write=True)
                if not p.exists():
                    return self._json(404, {"error": f"not found: {rel}"})
                if _readonly_for(cfg):
                    return self._json(403, {"error": "read-only mode is active"})
                confirm_params = {"op": "delete", "path": rel}
                confirm_token = body.get("confirmation_token")
                if not confirm_token:
                    iss = confirmation_issue(confirm_params)
                    desc = f"{p.stat().st_size} bytes" if p.is_file() else "directory"
                    return self._json(409, {
                        "error": f"deletion needs confirmation ({desc}) — the file "
                                 f"goes to the trash store, not unrecoverable",
                        "confirmation_required": True, **iss})
                okc, err = confirmation_consume(confirm_token, confirm_params)
                if not okc:
                    return self._json(400, {"error": err})
                okr, err = rate_check(0)
                if not okr:
                    return self._json(429, {"error": err, "rate_limited": True})
                info = trash_move(root, p)
                trash_purge(root)
                return self._json(200, {"ok": True, "trashed": info,
                                        "recover": "POST /trash/restore"})

            if u.path == "/trash/list":
                rel = body.get("path", "")
                rel = unquote(rel) if isinstance(rel, str) else ""
                _rp, _rr, _rc = resolve_guarded(rel or ".")
                return self._json(200, {"trash": trash_list(_rr, rel)})

            if u.path == "/trash/restore":
                rel = body.get("path", "")
                ts = str(body.get("ts", ""))
                if not rel or not ts:
                    return self._json(400, {"error": "need path + ts (from /trash/list)"})
                _rp, _rr, _rc = resolve_guarded(rel)
                if _readonly_for(_rc):
                    return self._json(403, {"error": "read-only mode is active"})
                okr, mes = trash_restore(_rr, rel, ts)
                if not okr:
                    return self._json(409, {"error": mes})
                return self._json(200, {"ok": True, "restored": mes})

            if u.path == "/trash/purge":
                return self._json(403, {"error": "manual purge is a settings-page "
                                                 "action, not an API call"})

            if u.path == "/write_many":
                # batch writes; >5 files needs {"confirmed": true} (mass-edit
                # detection, roadmap P0b)
                items = body.get("items", [])
                if not isinstance(items, list) or not items or len(items) > 50:
                    return self._json(400, {"error": "items must be a 1-50 list"})
                if len(items) > 5 and not body.get("confirmed"):
                    return self._json(409, {
                        "error": f"batch of {len(items)} files needs explicit "
                                 f"confirmation",
                        "confirmation_required": True,
                        "confirm_op": "list the plan to the user; on approval "
                                      "re-send with confirmed:true",
                        "plan": [{"path": it.get("path"),
                                  "bytes": len(it.get("content", ""))}
                                 for it in items]})
                results = []
                for it in items:
                    path = it.get("path", "")
                    content = it.get("content", "")
                    try:
                        p, root, cfg = resolve_guarded(unquote(path), for_write=True)
                        if _readonly_for(cfg):
                            raise PermissionError("read-only mode")
                        okr, err = rate_check(len(content))
                        if not okr:
                            return self._json(429, {"error": err, "rate_limited": True,
                                                    "hint": "batch aborted — files "
                                                            "written so far are listed",
                                                    "results": results})
                        snap = snapshot_before_write(root, p) if p.exists() else None
                        atomic_write_text(p, content)
                        results.append({"path": path, "ok": True, "bytes": len(content),
                                        "snapshot": snap})
                    except (PermissionError, ExcludedPath) as e:
                        results.append({"path": path, "ok": False, "error": str(e)})
                return self._json(200, {"ok": all(r.get("ok") for r in results),
                                        "results": results})
        except ExcludedPath as e:
            return self._json(403, {"error": str(e), "excluded": True,
                                    "hint": "write into an ignored path is refused; "
                                            "ask the user to adjust settings"})
        except PermissionError as e:
            return self._json(400, {"error": str(e)})
        except Exception as e:
            return self._json(500, {"error": str(e)})
        return self._json(404, {"error": "unknown endpoint"})

    def _is_loopback(self):
        try:
            ip = self.client_address[0]
            return ip in ("127.0.0.1", "::1", "localhost")
        except Exception:
            return False

    # ---- local picker API (/api/root) ----

    def _do_api_root(self):
        length = int(self.headers.get("Content-Length", 0))
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            return self._json(400, {"ok": False, "error": "invalid JSON"}, cors=False)

        self._audit("/api/root", args={k: "[redacted]" for k in body})  # settings changes: keys only

        if "ocr_lang" in body:
            _set_ocr_lang(str(body["ocr_lang"]).strip())

        # security settings ------------------------------------------------
        if "allowed_origin" in body:
            val = body["allowed_origin"]
            if val is None or (isinstance(val, str) and val.strip().lower() in ("", "none", "off")):
                set_allowed_origin(None)
            else:
                okn, norm = set_allowed_origin(str(val))
                if not okn:
                    return self._json(400, {"ok": False,
                                            "error": "invalid origin (want e.g. http://owui.internal:8080)"},
                                      cors=False)

        tok_action = body.get("token")
        new_token = None
        if isinstance(tok_action, dict):  # {"set": "..."} | {"clear": true} | {"generate": true}
            if tok_action.get("clear"):
                set_token(None)
            elif tok_action.get("generate"):
                new_token = generate_token()
            elif tok_action.get("set"):
                if not set_token(str(tok_action["set"])):
                    return self._json(400, {"ok": False, "error": "token must be 8-256 chars"},
                                      cors=False)
                new_token = str(tok_action["set"])  # show back once to the local admin
        elif tok_action is None and "token" in body:
            set_token(None)

        if isinstance(body.get("roots"), list):
            okr, err = set_roots(body["roots"])
            if not okr:
                return self._json(400, {"ok": False, "error": err}, cors=False)
        if "readonly" in body:
            _state_update(readonly=bool(body["readonly"]))
        if isinstance(body.get("ignore_global"), list):
            _state_update(ignore_global=[str(x)[:200] for x in body["ignore_global"]][:200])
        if body.get("root") and not isinstance(body.get("roots"), list):
            # legacy single-root setter (CLI arg path)
            p = Path(body["root"]).expanduser()
            if not p.is_dir():
                return self._json(400, {"ok": False, "error": f"not a folder: {p}"}, cors=False)
            save_root(p)
        ros = enabled_roots()
        resp = {"ok": True, "ocr_lang": _get_ocr_lang(),
                "roots": roots_config(), "root": ros[0]["path"] if ros else None}
        resp["allowed_origin"] = get_allowed_origin()
        resp["security"] = security_mode()
        if new_token:
            resp["token"] = new_token  # shown ONCE in the local picker only
        return self._json(200, resp, cors=False)

    # ---- local picker UI (served only to localhost browser) ----
    PICKER_HTML = """<!doctype html><html><head><meta charset="utf-8"><title>File Bridge</title>
<style>body{font-family:system-ui;max-width:680px;margin:50px auto;padding:0 20px;color:#222}
input{width:100%;padding:10px;font-size:16px;box-sizing:border-box}
button{padding:10px 22px;font-size:16px;margin-top:12px;cursor:pointer}
.ok{color:#0a7d32;font-weight:bold}.hint{color:#666;font-size:14px}
.warn{color:#b00;font-weight:bold}.sec{background:#f4f6f8;padding:14px 18px;border-radius:8px;margin:14px 0}
code{background:#eee;padding:2px 6px;border-radius:4px}</style></head><body>
<h2>📁 File Bridge</h2>
<p>This little service lets <b>Open WebUI in your browser</b> read &amp; write files
in <b>one folder you choose</b> on this computer. Nothing else is exposed.</p>
<p>Shared folder:</p>
<input id="root" placeholder="C:\\\\Users\\\\you\\\\Documents\\\\my-folder" value="__ROOT__">
<button onclick="setRoot()">Save folder</button>
<p class="ok" id="status"></p>
<div class="sec">
<h3>🔒 Security</h3>
<p class="hint">Lock the bridge to your Open WebUI address (required — until set,
file endpoints stay disabled):</p>
<input id="origin" placeholder="http://owui.yourcompany.com:8080" value="__ORIGIN__">
<button onclick="setOrigin()">Lock to this origin</button>
<p class="hint">Optional extra: org-wide token (Tier&nbsp;2). Generate one and give it to
your OWUI admin (it is embedded in the skill by setup_owui.py).</p>
<button onclick="genToken()">Generate token</button>
<button onclick="clearToken()">Clear token</button>
<p class="hint" id="secstatus"></p>
</div>
<hr>
<p>OCR language (for reading scanned PDFs / photos):</p>
<input id="ocrlang" placeholder="swe+eng" value="__OCRLANG__" style="max-width:200px">
<button onclick="setLang()">Save language</button>
<p class="hint" id="langs"></p>
<hr>
<p class="hint">Status: __STATUS__<br>Keep this window/service running while using Open WebUI.
You can close this browser tab — the service keeps running.</p>
<script>
async function refresh(){const s=await (await fetch('/state')).json();
document.getElementById('root').value=s.root||'';
document.getElementById('origin').value=s.allowed_origin||'';
document.getElementById('secstatus').textContent='Security mode: '+s.security;
const c=await (await fetch('/ocr/config')).json();
document.getElementById('ocrlang').value=c.lang||'eng';
document.getElementById('langs').textContent='Installed: '+(c.available||[]).join(', ')+' — engine: '+(c.engine||'?');}
async function setLang(){
 const l=document.getElementById('ocrlang').value.trim();
 const res=await fetch('/api/root',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ocr_lang:l})});
 const d=await res.json();
 document.getElementById('status').textContent=d.ok?'✓ OCR language: '+d.ocr_lang:'✗ '+(d.error||'failed');}
async function setRoot(){
 const r=document.getElementById('root').value.trim();
 const res=await fetch('/api/root',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({root:r})});
 const d=await res.json();
 document.getElementById('status').textContent=d.ok?'✓ Saved: '+d.root:'✗ '+d.error;
 refresh();}
async function setOrigin(){
 const o=document.getElementById('origin').value.trim();
 const res=await fetch('/api/root',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({allowed_origin:o})});
 const d=await res.json();
 document.getElementById('secstatus').textContent = d.ok?('Security mode: '+d.security+(d.error?' — '+d.error:'')):('✗ '+(d.error||'failed'));
 if(d.ok&&d.security==='UNLOCKED')document.getElementById('secstatus').textContent+=' ⚠ set an origin to unlock file serving';}
async function genToken(){
 const res=await fetch('/api/root',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:{generate:true}})});
 const d=await res.json();
 document.getElementById('secstatus').textContent = d.ok?('Token (copy now, shown once): '+d.token+' — mode: '+d.security):('✗ '+(d.error||'failed'));}
async function clearToken(){
 const res=await fetch('/api/root',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:{clear:true}})});
 const d=await res.json();
 document.getElementById('secstatus').textContent='Security mode: '+d.security;}
refresh();
</script></body></html>"""


def _is_readonly() -> bool:
    if os.environ.get("FILE_BRIDGE_READONLY", "").lower() in ("1", "true", "yes"):
        return True
    return bool(_state_load().get("readonly"))


def main():
    folder = sys.argv[1] if len(sys.argv) > 1 else None
    if folder:
        p = Path(folder).expanduser().resolve()
        if not p.is_dir():
            print(f"error: {folder} is not a folder"); sys.exit(1)
        save_root(p)
        print(f"Sharing: {p}")

    root = load_root()

    # serve picker page (local setup UI)
    orig_do_GET = Handler.do_GET
    def do_GET_picker(self):
        if urlparse(self.path).path in ("/", "/picker"):
            root = load_root()
            html = Handler.PICKER_HTML.replace("__ROOT__", str(root) if root else "")
            html = html.replace("__ORIGIN__", get_allowed_origin() or "")
            html = html.replace("__OCRLANG__", _get_ocr_lang())
            html = html.replace("__STATUS__",
                                f"sharing {root} · security {security_mode()}" if root
                                else f"no folder chosen yet · security {security_mode()}")
            body = html.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        return orig_do_GET(self)
    Handler.do_GET = do_GET_picker

    socketserver.ThreadingTCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(("127.0.0.1", PORT), Handler) as httpd:
        url = f"http://127.0.0.1:{PORT}"
        mode = security_mode()
        print(f"File Bridge v{VERSION} running at {url}  (Ctrl+C to stop)")
        print(f"Security mode: {mode}")
        if mode == "UNLOCKED":
            print("⚠ UNLOCKED: file endpoints are DISABLED until you set the allowed")
            print("  Open WebUI origin (and optionally a token) in the settings page.")
        if not root:
            print("No folder set — opening folder picker in your browser...")
            threading.Timer(0.5, lambda: webbrowser.open(url)).start()
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nFile Bridge stopped.")


if __name__ == "__main__":
    main()
