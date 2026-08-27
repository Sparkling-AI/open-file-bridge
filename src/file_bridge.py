#!/usr/bin/env python3
"""
File Bridge — single-file, stdlib-only local file service for Open WebUI.
No dependencies. Works with Python 3.8+. Package with PyInstaller for
double-click binaries on Windows/macOS/Linux.

Usage: python file_bridge.py [folder]      (default: ~/file-bridge-shared)
Then:  pick a folder at http://127.0.0.1:8765 (opens in browser)
"""
import base64
import binascii
import http.server
import json
import os
import socketserver
import sys
import threading
import time
import webbrowser
from pathlib import Path
from urllib.parse import urlparse, parse_qs, unquote

PORT = 8765
STATE_FILE = Path.home() / ".file-bridge.json"
MAX_LIST = 500
MAX_READ = 200_000      # chars (text)
MAX_BINARY = 8_000_000  # bytes (base64 endpoints)

# Wheel hosting: serve pure-Python wheels bundled next to this file in ./wheels/
# so Pyodide installs them from localhost instead of PyPI (fast + offline).
WHEELS_DIR = Path(__file__).resolve().parent / "wheels"

# CORS headers allowing the Open WebUI page to call us.
# NOTE: In production, replace * with your actual OWUI origin for safety.
CORS_HEADERS = [
    ("Access-Control-Allow-Origin", "*"),
    ("Access-Control-Allow-Private-Network", "true"),
    ("Access-Control-Allow-Methods", "GET, POST, OPTIONS"),
    ("Access-Control-Allow-Headers", "Content-Type"),
]


def load_root() -> Path | None:
    try:
        p = json.loads(STATE_FILE.read_text())["root"]
        p = Path(p)
        return p if p.is_dir() else None
    except Exception:
        return None


def save_root(p: Path):
    STATE_FILE.write_text(json.dumps({"root": str(p.resolve())}))


def resolve_safe(root: Path, rel: str) -> Path:
    p = (root / rel).resolve()
    if os.path.commonpath([str(root.resolve()), str(p)]) != str(root.resolve()):
        raise PermissionError("path escapes shared root")
    return p


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write(f"[bridge] {self.address_string()} {fmt % args}\n")

    def _cors(self):
        for k, v in CORS_HEADERS:
            self.send_header(k, v)

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self._cors()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Access-Control-Max-Age", "86400")
        self.end_headers()

    def do_GET(self):
        root = load_root()
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}

        if u.path == "/health":
            if root:
                return self._json(200, {"ok": True, "root": str(root), "version": "1.0"})
            return self._json(200, {"ok": False, "hint": "no folder chosen yet"})

        if u.path == "/state":
            return self._json(200, {"root": str(root) if root else None, "port": PORT})

        # ---- wheel hosting (works regardless of chosen folder) ----
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
            self._cors()
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return

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

        except PermissionError as e:
            return self._json(400, {"error": str(e)})
        except Exception as e:
            return self._json(500, {"error": str(e)})
        return self._json(404, {"error": "unknown endpoint"})

    def do_POST(self):
        root = load_root()
        u = urlparse(self.path)
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
            if u.path == "/choose":
                # from the local picker UI (same machine only)
                return self._json(404, {"error": "use the web picker"})
        except PermissionError as e:
            return self._json(400, {"error": str(e)})
        except Exception as e:
            return self._json(500, {"error": str(e)})
        return self._json(404, {"error": "unknown endpoint"})

    # ---- local picker UI (served only to localhost browser) ----
    PICKER_HTML = """<!doctype html><html><head><meta charset="utf-8"><title>File Bridge</title>
<style>body{font-family:system-ui;max-width:640px;margin:60px auto;padding:0 20px;color:#222}
input{width:100%;padding:10px;font-size:16px;box-sizing:border-box}
button{padding:10px 22px;font-size:16px;margin-top:12px;cursor:pointer}
.ok{color:#0a7d32;font-weight:bold}.hint{color:#666;font-size:14px}</style></head><body>
<h2>📁 File Bridge</h2>
<p>This little service lets <b>Open WebUI in your browser</b> read &amp; write files
in <b>one folder you choose</b> on this computer. Nothing else is exposed.</p>
<p>Shared folder:</p>
<input id="root" placeholder="C:\\Users\\you\\Documents\\my-folder" value="__ROOT__">
<button onclick="setRoot()">Save folder</button>
<p class="ok" id="status"></p>
<hr>
<p class="hint">Status: __STATUS__<br>Keep this window/service running while using Open WebUI.
You can close this browser tab — the service keeps running.</p>
<script>
async function refresh(){const s=await (await fetch('/state')).json();
document.getElementById('root').value=s.root||'';}
async function setRoot(){
 const r=document.getElementById('root').value.trim();
 const res=await fetch('/api/root',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({root:r})});
 const d=await res.json();
 document.getElementById('status').textContent=d.ok?'✓ Saved: '+d.root:'✗ '+d.error;
}
refresh();
</script></body></html>"""

    def do_POST_picker(self):  # /api/root
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length) or b"{}")
        p = Path(body["root"]).expanduser()
        if not p.is_dir():
            return self._json(400, {"ok": False, "error": f"not a folder: {p}"})
        save_root(p)
        return self._json(200, {"ok": True, "root": str(p.resolve())})


def serve_picker_api(handler_cls):
    # extend do_POST to handle /api/root locally
    orig_do_POST = handler_cls.do_POST

    def do_POST(self):
        if urlparse(self.path).path == "/api/root":
            return Handler.do_POST_picker(self)
        return orig_do_POST(self)

    handler_cls.do_POST = do_POST


def main():
    folder = sys.argv[1] if len(sys.argv) > 1 else None
    if folder:
        p = Path(folder).expanduser().resolve()
        if not p.is_dir():
            print(f"error: {folder} is not a folder"); sys.exit(1)
        save_root(p)
        print(f"Sharing: {p}")

    root = load_root()
    serve_picker_api(Handler)

    # serve picker page
    orig_do_GET = Handler.do_GET
    def do_GET(self):
        if urlparse(self.path).path in ("/", "/picker"):
            root = load_root()
            html = Handler.PICKER_HTML.replace("__ROOT__", str(root) if root else "")
            html = html.replace("__STATUS__", f"sharing {root}" if root else "no folder chosen yet")
            body = html.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        return orig_do_GET(self)
    Handler.do_GET = do_GET

    socketserver.ThreadingTCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(("127.0.0.1", PORT), Handler) as httpd:
        url = f"http://127.0.0.1:{PORT}"
        print(f"File Bridge running at {url}  (Ctrl+C to stop)")
        if not root:
            print("No folder set — opening folder picker in your browser...")
            threading.Timer(0.5, lambda: webbrowser.open(url)).start()
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nFile Bridge stopped.")


if __name__ == "__main__":
    main()
