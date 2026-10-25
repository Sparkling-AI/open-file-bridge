#!/usr/bin/env python3
"""Build extension/inject-main.js from inject-main.template.js + ofb-client.py.

Embeds the Python client as a JSON string literal (json.dumps handles
every quote/backslash/newline correctly — the hand-written template-
literal versions broke 3x in the Stage-1 spike). Run from repo root:
    python3 scripts/build_inject.py
"""
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
EXT = HERE.parent / "extension"
tpl = (EXT / "inject-main.template.js").read_text(encoding="utf-8")
py = (EXT / "ofb-client.py").read_text(encoding="utf-8")
out = tpl.replace('"__OFB_CLIENT_PY_PLACEHOLDER__"', json.dumps(py))
(EXT / "inject-main.js").write_text(out, encoding="utf-8")
print(f"wrote extension/inject-main.js ({len(out)} bytes, "
      f"client {len(py)} bytes)")
