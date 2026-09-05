#!/usr/bin/env python3
"""Static regression checks for the chat-side approval contract."""

import ast
import io
from pathlib import Path
import re
import zipfile


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
        assert "skill v2.10.1" in text, name
        assert 'PENDING_BRIDGE_WRITE = globals().get("PENDING_BRIDGE_WRITE")' in text, name
        assert "async def bridge_commit_approved():" in text, name
        assert 'if k != "confirmation_token"' in text, name
        assert "STOP and ask the user for approval" in text, name
        assert "Only `approval_error: expired` means" in text or \
               "`approval_error: expired`" in text, name

    for name in ("SKILL-STRICT.md", "SKILL-STRICT-TOKEN.md"):
        text = (SKILL_DIR / name).read_text(encoding="utf-8")
        assert "for name, data in sorted(parts.items()):" in text, name
        assert "zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))" in text, name
        assert "Do not rebuild the document." in text, name

    parts = {"word/document.xml": "<doc>same</doc>", "_rels/.rels": "<rels/>"}
    assert build_deterministic_zip(parts) == build_deterministic_zip(parts)

    print("skill approval contract: PASS")


if __name__ == "__main__":
    main()
