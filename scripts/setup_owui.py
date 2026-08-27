#!/usr/bin/env python3
"""One-shot server-side setup for admins: creates the public Skill + the
model preset on an Open WebUI instance via its REST API. Verified against
Open WebUI v0.11.1.

The script reads the skill body from skill/local-file-bridge.skill.md in the
repo. To embed an org-wide bridge token (Tier-2 enterprise hardening), pass
--bridge-token; setup_owui injects it into the skill's bootstrap block.

Usage:
  python3 scripts/setup_owui.py --url http://your-owui:8080 \\
      --email admin@example.com --password ... \\
      --base-model glm-5.3-flash \\
      [--bridge-token SECRET]        # opt-in Tier 2: org-wide token
"""
import argparse
import json
import re
import sys
import urllib.request
from pathlib import Path

SKILL_ID = "local-file-bridge"
MODEL_ID = "local-files-assistant"
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
    args = ap.parse_args()
    base = args.url.rstrip("/")

    # 1. sign in
    tok = api("POST", f"{base}/api/v1/auths/signin",
              None, {"email": args.email, "password": args.password})["token"]
    print("✓ signed in")

    # 2. skill body (with optional token header injection)
    skill_md = (REPO / "skill" / "local-file-bridge.skill.md").read_text()
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
    if any(s.get("id") == SKILL_ID for s in existing):
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
