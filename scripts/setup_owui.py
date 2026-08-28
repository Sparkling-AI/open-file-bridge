#!/usr/bin/env python3
"""One-shot server-side setup for admins: creates the public Skill + the
model preset on an Open WebUI instance via its REST API. Verified against
Open WebUI v0.11.1.

The script reads the skill body from skill/local-file-bridge/SKILL.md
in the repo. To embed an org-wide bridge token (Tier-2 enterprise
hardening), pass --bridge-token; setup_owui injects it into the skill's
bootstrap block.

When the skill already exists on the server, a unified diff of the
incoming body vs the live one is shown first; update proceeds only
after confirmation (or immediately with --yes).

Usage:
  python3 scripts/setup_owui.py --url http://your-owui:8080 \\
      --email admin@example.com --password ... \\
      --base-model glm-5.3-flash \\
      [--bridge-token SECRET]        # opt-in Tier 2: org-wide token
"""
import argparse
import difflib
import json
import re
import sys
import urllib.request
from pathlib import Path

SKILL_ID = "local-file-bridge"
MODEL_ID = "local-files-assistant"
SKILL_DIR = "skill/local-file-bridge"
# keep in sync with VERSION/SKILL_VERSION in src/file_bridge.py and the
# skill folder's CHANGELOG.md
SKILL_VERSION = "2.3"
REPO = Path(__file__).resolve().parent.parent


def api(method, url, token=None, data=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(
        url,
        data=json.dumps(data).encode() if data else None,
        headers=headers,
        method=method,
    )
    try:
        r = urllib.request.urlopen(req, timeout=30)
        return json.loads(r.read() or "{}")
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code} on {method} {url}: {e.read().decode()[:200]}")
        sys.exit(1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True, help="OWUI base URL, e.g. http://owui.internal:8080")
    ap.add_argument("--email", required=True)
    ap.add_argument("--password", required=True)
    ap.add_argument("--base-model", required=True, help="existing model id, e.g. glm-5.3-flash")
    ap.add_argument("--bridge-token", default=None,
                    help="Tier 2: org-wide token embedded in the skill "
                         "(bridge must be configured with the same token)")
    ap.add_argument("--yes", "-y", action="store_true",
                    help="apply the skill update without the diff-preview "
                         "prompt (unattended installs)")
    args = ap.parse_args()
    base = args.url.rstrip("/")

    # 1. sign in
    tok = api("POST", f"{base}/api/v1/auths/signin",
              None, {"email": args.email, "password": args.password})["token"]
    print("✓ signed in")

    # 2. skill body (with optional token header injection)
    skill_md = (REPO / SKILL_DIR / "SKILL.md").read_text()
    if skill_md.startswith("---"):
        skill_md = skill_md.split("---", 2)[2].lstrip("\n")
    if args.bridge_token:
        inject = (
            '# Org token (Tier 2): every bridge call MUST send this header.\n'
            'BRIDGE_HEADERS = {"X-Bridge-Token": "%s"}\n' % args.bridge_token
        )
        skill_md = re.sub(r"(## Bootstrap helpers \(run once per session\)\n)",
                          r"\1\n" + inject, skill_md, count=1)
        if "X-Bridge-Token" not in skill_md:
            skill_md = inject + "\n" + skill_md  # fallback: prepend

    skill = {
        "id": SKILL_ID, "name": "Local File Bridge",
        "description": "Read/write files in the user's chosen local folder via the "
                       "File Bridge app (http://127.0.0.1:8765). Needs Code Interpreter.",
        "content": skill_md,
        "meta": {}, "is_active": True,
        "access_grants": [{"principal_type": "user", "principal_id": "*", "permission": "read"}],
    }
    existing = api("GET", f"{base}/api/v1/skills/", tok)
    # the LIST endpoint omits `content` — fetch the full record by id
    live = next((s for s in existing if s.get("id") == SKILL_ID), None)
    if live is not None:
        full = api("GET", f"{base}/api/v1/skills/id/{SKILL_ID}", tok)
        if isinstance(full, dict) and full.get("content"):
            live = full
    if live is not None:
        # preview BEFORE overwriting (their staging pattern): show what
        # the skill-body update would change, ask unless --yes
        live_md = live.get("content") or ""
        if live_md != skill_md:
            diff = difflib.unified_diff(
                live_md.splitlines(keepends=True),
                skill_md.splitlines(keepends=True),
                fromfile=f"live skill ({SKILL_ID})",
                tofile=f"new skill ({SKILL_VERSION})",
                n=1,
            )
            dlines = list(diff)
            print(f"--- skill body diff ({len([l for l in dlines if l.startswith(('+', '-')) and not l.startswith(('+++', '---'))])} changed lines) ---")
            for line in dlines[:120]:
                print("  " + line.rstrip())
            if len(dlines) > 120:
                print(f"  … ({len(dlines) - 120} more diff lines)")
            print("--- end diff ---")
            if not args.yes:
                try:
                    ans = input("Apply this skill update? [y/N] ")
                except EOFError:
                    ans = ""
                if ans.strip().lower() not in ("y", "yes"):
                    print("⏭ skill NOT updated (preset setup continues)")
                    live = None
        if live is not None:
            r = api("POST", f"{base}/api/v1/skills/id/{SKILL_ID}/update", tok, skill)
            print(f"✓ skill updated: {r.get('id')}")
    else:
        r = api("POST", f"{base}/api/v1/skills/create", tok, skill)
        print(f"✓ skill created: {r.get('id')}")
    api("POST", f"{base}/api/v1/skills/id/{SKILL_ID}/access/update", tok,
        {"access_grants": [{"principal_type": "user", "principal_id": "*", "permission": "read"}]})
    print("✓ skill public")

    # 3. model preset — the two-switch gotcha:
    #    BOTH capabilities.code_interpreter AND defaultFeatureIds are required.
    model = {
        "id": MODEL_ID, "base_model_id": args.base_model,
        "name": "Local Files Assistant",
        "meta": {
            "description": "Access your own local files through the File Bridge app.",
            "capabilities": {"code_interpreter": True},
            "defaultFeatureIds": ["code_interpreter"],
            "skillIds": [SKILL_ID],
        },
        "params": {},
        "access_grants": [{"principal_type": "user", "principal_id": "*", "permission": "read"}],
        "is_active": True,
    }
    models = api("GET", f"{base}/api/v1/models/export", tok)
    if any(m.get("id") == MODEL_ID for m in models):
        r = api("POST", f"{base}/api/v1/models/model/update", tok, model)
        print(f"✓ model preset updated: {r.get('id')}")
    else:
        r = api("POST", f"{base}/api/v1/models/create", tok, model)
        print(f"✓ model preset created: {r.get('id')}")

    # 4. code interpreter engine (admin default) — read current, warn only
    ci = api("GET", f"{base}/api/v1/configs/code_execution", tok)
    if not ci.get("ENABLE_CODE_INTERPRETER") or ci.get("CODE_INTERPRETER_ENGINE") != "pyodide":
        print("⚠ Admin Settings → Code Execution: enable Code Interpreter with the "
              "Pyodide engine (current: %s)" % ci.get("CODE_INTERPRETER_ENGINE"))
    else:
        print("✓ code interpreter: pyodide engine enabled")

    print()
    print("Done. Users should now:")
    print("  1. Install & run File Bridge on their machine, pick a folder")
    print(f"  2. Select the '{MODEL_ID}' model in a new chat")
    print("  3. Ask for a file; click Allow on the browser's local-network prompt")


if __name__ == "__main__":
    main()
