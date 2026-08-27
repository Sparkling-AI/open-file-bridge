---
name: local-file-bridge
description: Read and write files in the user's chosen local folder via the File Bridge app (http://127.0.0.1:8765). Use with Code Interpreter (Pyodide engine) enabled.
---

# Local File Bridge

Access files in **the user's own computer** through their local File Bridge service (running at `http://127.0.0.1:8765`). The user has explicitly installed and authorized this — files NEVER pass through the Open WebUI server; all access happens from the user's browser via the Code Interpreter (Pyodide), which runs on the user's machine.

## How to use

Always run this Python via the **Code Interpreter** — it executes in the user's browser and can reach their local bridge:

```python
from pyodide.http import pyfetch
import json

async def bridge_get(path, params=None):
    url = f"http://127.0.0.1:8765{path}"
    if params:
        url += "?" + "&".join(f"{k}={v}" for k, v in params.items())
    r = await pyfetch(url)
    if r.status != 200:
        raise RuntimeError(f"bridge {path} -> HTTP {r.status}")
    return await r.json()

async def bridge_post(path, payload):
    r = await pyfetch(f"http://127.0.0.1:8765{path}", method="POST",
                      headers={"Content-Type": "application/json"},
                      body=json.dumps(payload))
    if r.status != 200:
        raise RuntimeError(f"bridge {path} -> HTTP {r.status}")
    return await r.json()

# List the user's shared folder
listing = await bridge_get("/list", {"path": "."})
for e in listing["entries"][:20]:
    print(e["type"], e["path"])

# Read a file
f = await bridge_get("/read", {"path": "notes.txt"})
print(f["content"])

# Write a file
await bridge_post("/write", {"path": "report.md", "content": "# Hello"})
```

## Rules

1. If a request fails with a connection error, tell the user: "Your File Bridge isn't running — please start the File Bridge app on your computer, then ask me again." Do NOT retry more than once.
2. The browser may ask once for permission to access the local network — the user must click **Allow**.
3. Only touch files inside the folder the user shared in the File Bridge app. Never try paths like `../../`.
4. For big files, ask the user first.
5. The bridge only allows list, read, write. No delete or move.

## Detection

If unsure whether the bridge is running, run `await bridge_get("/health")` — `{"ok": true}` means it is running.
