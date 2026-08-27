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
            info = {"ok": True, "root": str(root), "version": VERSION} if root else \
                   {"ok": False, "hint": "no folder chosen yet"}
            info["addons"] = {"pdf": HAVE_PYMUPDF, "ocr": bool(TESSERACT_BIN)}
            info["ocr_lang"] = _get_ocr_lang()
            info["ocr_langs_available"] = _ocr_langs_available()
            info["wheels"] = len(list(WHEELS_DIR.glob("*.whl"))) if WHEELS_DIR.is_dir() else 0
            mode = security_mode()
            info["security"] = mode
            info["locked"] = mode != "UNLOCKED"
            return self._json(200, info)

        if u.path == "/state":
            return self._json(200, {"root": str(root) if root else None, "port": PORT,
                                    "ocr_lang": _get_ocr_lang(),
                                    "allowed_origin": get_allowed_origin(),
                                    "security": security_mode(),
                                    "readonly": _is_readonly()})

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
                p = resolve_safe(root, unquote(q.get("path", ".")))
                if not p.is_dir():
                    return self._json(404, {"error": f"not a directory: {q.get('path')}"})
                entries = []
                for f in sorted(p.rglob("*")):
                    rel = f.relative_to(root).as_posix()
                    try:
                        st = f.stat()
                        entries.append({"path": rel, "type": "dir" if f.is_dir() else "file",
                                        "size": None if f.is_dir() else st.st_size,
                                        "mtime": int(st.st_mtime)})
                    except OSError:
                        continue
                    if len(entries) >= MAX_LIST:
                        break
                return self._json(200, {"root": str(root), "entries": entries})

            if u.path == "/read":
                p = resolve_safe(root, unquote(q.get("path", "")))
                if not p.is_file():
                    return self._json(404, {"error": f"no such file: {q.get('path')}"})
                data = p.read_text(encoding="utf-8", errors="replace")[:MAX_READ]
                return self._json(200, {"path": q.get("path"), "content": data})

            if u.path == "/read_b64":
                # binary-safe read: returns base64. For Office files, images,
                # PDFs. Capped at MAX_BINARY bytes.
                p = resolve_safe(root, unquote(q.get("path", "")))
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
                p = resolve_safe(root, unquote(q.get("path", "")))
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
                p = resolve_safe(root, unquote(q.get("path", "")))
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
                p = resolve_safe(root, unquote(q.get("path", "")))
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
                p = resolve_safe(root, unquote(body.get("path", "")))
                content = body.get("content", "")
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text(content, encoding="utf-8")
                return self._json(200, {"ok": True, "written": str(p), "bytes": len(content)})

            if u.path == "/write_b64":
                # binary-safe write: takes base64. For Office/PDF/image files.
                p = resolve_safe(root, unquote(body.get("path", "")))
                try:
                    raw = base64.b64decode(body.get("b64", ""), validate=True)
                except (binascii.Error, ValueError) as e:
                    return self._json(400, {"error": f"invalid base64: {e}"})
                if len(raw) > MAX_BINARY:
                    return self._json(413, {"error": f"payload too large: {len(raw)} > {MAX_BINARY} bytes"})
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_bytes(raw)
                return self._json(200, {"ok": True, "written": str(p), "bytes": len(raw)})
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

        if body.get("root"):
            p = Path(body["root"]).expanduser()
            if not p.is_dir():
                return self._json(400, {"ok": False, "error": f"not a folder: {p}"}, cors=False)
            save_root(p)
            resp = {"ok": True, "root": str(p.resolve()), "ocr_lang": _get_ocr_lang()}
        else:
            resp = {"ok": True, "ocr_lang": _get_ocr_lang()}
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
