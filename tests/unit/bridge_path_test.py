#!/usr/bin/env python3
"""F1 regression: bridge_path must never re-anchor an explicit root, and
must not treat an ordinary relative path as an absolute one.

Runs the REAL function extracted (by AST) from all three copies that ship
it: the injected Pyodide client and both skill bootstraps. A drift between
copies fails here too.

    python3 tests/unit/bridge_path_test.py
"""
import ast
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
COPIES = [
    REPO / "extension" / "ofb-client.py",
    REPO / "skill" / "open-file-bridge" / "SKILL-EXT.md",
    REPO / "skill" / "open-file-bridge" / "SKILL-EXT-TOKEN.md",
]

R2 = [{"id": "rA", "alias": "Shared", "path": "Shared"},
      {"id": "rB", "alias": "Archive", "path": "Archive"}]
R1 = [{"id": "main", "alias": "Shared", "path": "Shared"}]
R2_PLAIN = [{"id": "rA", "path": "rA"}, {"id": "rB", "path": "rB"}]

# (roots, input, expected) — "ERR" means BridgeError is the expected answer
CASES = [
    # --- the review's F1 repros -------------------------------------
    (R2, "rA/reports/Archive/budget.xlsx", "rA/reports/Archive/budget.xlsx"),
    (R2, "rA/Shared/budget.xlsx", "rA/Shared/budget.xlsx"),
    # --- explicit root + another root's alias, descendant repeats own
    (R2, "rB/Shared/x.txt", "rB/Shared/x.txt"),
    (R2, "rA/rA/x.txt", "rA/rA/x.txt"),
    (R2, "rB/Archive/x.txt", "rB/Archive/x.txt"),
    # --- plain relative paths never re-anchored ---------------------
    (R2, "reports/Archive/budget.xlsx", "reports/Archive/budget.xlsx"),
    # ...but a FIRST segment naming a root IS a qualifier in multi-root
    # mode, exactly as resolveGuarded treats it (so a paste of
    # "Archive/x.txt" means root rB, not roots[0]/Archive/x.txt)
    (R2, "Archive/x.txt", "rB/x.txt"),
    (R2_PLAIN, "rA/x.txt", "rA/x.txt"),
    (R1, "notes/x.txt", "notes/x.txt"),
    # single root: the alias IS a real subfolder name, not a qualifier
    (R1, "Shared/x.txt", "Shared/x.txt"),
    (R1, "a/Shared/b.txt", "a/Shared/b.txt"),
    # --- Windows absolute, ancestor sharing the root name (3.7.2) ---
    (R1, r"N:\Shared\Open Lan\shared\202608\x.txt", "202608/x.txt"),
    (R1, r"N:\Open Lan Shared\shared\a\b\c.txt", "a/b/c.txt"),
    (R2, r"N:\foo\Archive\x.txt", "rB/x.txt"),
    (R1, r"C:\Users\d\Shared\a\b.txt", "a/b.txt"),
    # --- POSIX absolute --------------------------------------------
    (R1, "/Users/d/Shared/a/b.txt", "a/b.txt"),
    (R2, "/mnt/Archive/a.txt", "rB/a.txt"),
    # --- root-qualified shorthand ----------------------------------
    (R2, "rA", "rA"),
    (R2, "rA/", "rA"),
    # --- errors, never a wrong file --------------------------------
    (R1, r"Z:\nope\x.txt", "ERR"),
    (R2, r"N:\Shared\Archive\x.txt", "ERR"),   # two roots could own it
]


def extract_copy(path: Path) -> str:
    text = path.read_text(encoding="utf-8")
    if path.suffix == ".md":
        blocks = re.findall(r"```python\n(.*?)```", text, re.S)
        text = next(b for b in blocks if "def bridge_path" in b)
    return text


def load(path: Path):
    src = extract_copy(path)
    tree = ast.parse(src)
    fn = next(n for n in tree.body
              if isinstance(n, ast.FunctionDef) and n.name == "bridge_path")
    ns = {"BridgeError": RuntimeError, "_S": {"roots": []}}
    exec(compile(ast.Module(body=[fn], type_ignores=[]), str(path), "exec"), ns)
    return ns


def main() -> int:
    failures = 0
    loaded = {p: load(p) for p in COPIES}
    for path, ns in loaded.items():
        bp = ns["bridge_path"]
        label = str(path.relative_to(REPO))
        for roots, given, want in CASES:
            ns["_S"]["roots"] = roots
            try:
                got = bp(given)
            except Exception as e:                      # noqa: BLE001
                got = "ERR"
                err = str(e)
            else:
                err = ""
            if got != want:
                failures += 1
                print("FAIL %-46s %-40r -> %-38r want %r%s"
                      % (label, given, got, want,
                         ("  [" + err + "]") if err else ""))
    print("%d copies x %d cases, %d failure(s)"
          % (len(loaded), len(CASES), failures))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
