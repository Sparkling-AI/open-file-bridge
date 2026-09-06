#!/usr/bin/env python3
"""Static regression checks for the chat-side write contract (skill 2.11).

Skill 2.11 removed the chat-side approval round trip entirely: writes are
committed in the same turn, safety comes from bridge-side snapshots + trash.
This suite pins that contract: no pending-write globals, no approval
helpers, no token plumbing, deterministic-zip recipe intact, and the
discovery description still carries the bridge-only safety invariant.
"""

import ast
import io
import re
import zipfile
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]
SKILL_DIR = REPO / "skill" / "open-file-bridge"
VARIANTS = (
    "SKILL.md",
    "SKILL-TOKEN.md",
    "SKILL-STRICT.md",
    "SKILL-STRICT-TOKEN.md",
)


def build_deterministic_zip(parts: dict[str, str]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in sorted(parts.items()):
            info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, data)
    return buf.getvalue()


def main() -> None:
    setup_tree = ast.parse((REPO / "scripts" / "setup_owui.py").read_text())
    published_description = None
    for node in setup_tree.body:
        if isinstance(node, ast.Assign) and any(
                isinstance(target, ast.Name) and target.id == "UNIFIED_DESC"
                for target in node.targets):
            published_description = ast.literal_eval(node.value)
            break
    assert published_description is not None

    for name in VARIANTS:
        text = (SKILL_DIR / name).read_text(encoding="utf-8")
        found = re.search(r'^description: "(.*)"$', text, re.MULTILINE)
        assert found and found.group(1) == published_description, name
        for purpose in ("Read", "create", "edit", "search", "convert", "organize"):
            assert purpose in published_description, purpose
        assert "requests involving the user's local" in published_description
        assert "MUST-CALL before acting" in published_description
        assert "successful bridge response confirms" in published_description
        assert "skill v2.11" in text, name

        # --- the removed approval machinery must STAY removed ---
        assert "PENDING_BRIDGE_WRITE" not in text, name
        assert "bridge_commit_approved" not in text, name
        assert "confirmation_token" not in text, name
        assert "approval_error" not in text, name
        assert "STOP and ask the user for approval" not in text, name

        # --- the new snapshot-based safety contract ---
        assert "snapshot" in text, name
        assert "/versions/restore" in text, name
        assert "/trash/restore" in text, name

        # --- every python block still parses ---
        for i, block in enumerate(re.findall(
                r"```python\n(.*?)```", text, re.DOTALL)):
            lines = []
            for line in block.splitlines():
                # allow the documented pseudo-placeholder as a no-op body
                if "<install block above>" in line:
                    lines.append(line.replace("<install block above>", "pass"))
                else:
                    lines.append(line)
            try:
                ast.parse("\n".join(lines))
            except SyntaxError as e:
                raise AssertionError(f"{name} python block #{i}: {e}") from e

    for name in ("SKILL-STRICT.md", "SKILL-STRICT-TOKEN.md"):
        text = (SKILL_DIR / name).read_text(encoding="utf-8")
        assert "for name, data in sorted(parts.items()):" in text, name
        assert "zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))" in text, name
        assert "build it ONCE and reuse the same bytes" in text, name

    parts = {"word/document.xml": "<doc>same</doc>", "_rels/.rels": "<rels/>"}
    assert build_deterministic_zip(parts) == build_deterministic_zip(parts)

    print("skill write contract: PASS")


if __name__ == "__main__":
    main()
