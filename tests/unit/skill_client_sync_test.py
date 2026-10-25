#!/usr/bin/env python3
"""The Pyodide client ships in THREE places and they must not drift:
  - extension/ofb-client.py        (source of truth, embedded in inject-main.js)
  - skill/open-file-bridge/SKILL-EXT.md        (pasted bootstrap, no token)
  - skill/open-file-bridge/SKILL-EXT-TOKEN.md  (pasted bootstrap, token)

The skill copies carry a DOCSTRING on bridge_path and the client does not
(it is exec()'d, where a docstring is dead weight), so this compares the
normative helpers while ignoring docstrings and blank lines. Drift here is
how the 3.7.2 bridge_path fix nearly landed in one copy only.

    python3 tests/unit/skill_client_sync_test.py
"""
import ast
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CLIENT = REPO / "extension" / "ofb-client.py"
SKILLS = [REPO / "skill" / "open-file-bridge" / "SKILL-EXT.md",
          REPO / "skill" / "open-file-bridge" / "SKILL-EXT-TOKEN.md"]

# Helpers the skills must carry with IDENTICAL behaviour. ofb_init,
# ofb_fetch, read_binary and read_binary_range are deliberately excluded:
# the injected client reports `client`+`helpers` from ofb_init and resolves
# the js transport differently, because exec() cannot run top-level awaits.
CHECKED = ["bridge_path", "bridge_get", "bridge_post", "ofb_fetch_b64",
           "read_text", "write_text", "write_binary", "out", "ofb_set_token",
           "install_bridge_wheels"]


def skill_python(path: Path) -> str:
    text = path.read_text(encoding="utf-8")
    blocks = re.findall(r"```python\n(.*?)```", text, re.S)
    return next(b for b in blocks if "def bridge_path" in b)


def norm(fn: ast.AST) -> str:
    """Function source with docstrings, comments and blank lines removed —
    the parts that decide behaviour."""
    node = ast.parse(ast.unparse(fn)).body[0]
    if (node.body and isinstance(node.body[0], ast.Expr)
            and isinstance(node.body[0].value, ast.Constant)
            and isinstance(node.body[0].value.value, str)):
        node.body.pop(0)
    return ast.dump(node)


def collect(src: str, label: str):
    tree = ast.parse(src)
    out = {}
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            out[node.name] = node
    return out


def main() -> int:
    base = collect(CLIENT.read_text(encoding="utf-8"), "client")
    failures = 0
    for skill in SKILLS:
        other = collect(skill_python(skill), str(skill))
        for name in CHECKED:
            if name not in base:
                print("FAIL client has no %s" % name)
                failures += 1
                continue
            if name not in other:
                print("FAIL %s is missing %s" % (skill.name, name))
                failures += 1
                continue
            if norm(base[name]) != norm(other[name]):
                print("FAIL %s: %s differs from extension/ofb-client.py" % (skill.name, name))
                failures += 1
    print("%d helper(s) x %d skill copies, %d failure(s)"
          % (len(CHECKED), len(SKILLS), failures))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
