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
    shutil.copy2(snap_root, target)
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
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        if cors:
            self._add_matching_cors()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

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
                "ignore_global": _global_ignore()})

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
                    return self._json(200, {"path": q.get("path"), "page_count": total,
                                            "pages": pages_out})
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
                return self._json(200, {"path": q.get("path"), "lang": lang,
                                        "pages": results})

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
                snap = snapshot_before_write(root, p) if p.exists() else None
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text(content, encoding="utf-8")
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
                snap = snapshot_before_write(root, p) if p.exists() else None
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_bytes(raw)
                return self._json(200, {"ok": True, "written": str(p), "bytes": len(raw),
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
