#!/usr/bin/env python3
"""One-shot server-side setup for admins: creates the public Skill + the
model preset on an Open WebUI instance via its REST API.

Verified working against Open WebUI v0.11.1.

Usage:
  python3 scripts/setup_owui.py --url http://your-owui:8080 \\
      --email admin@example.com --password ... \\
      --base-model glm-5.3-flash
"""
import argparse
import json
import sys
import urllib.request
from pathlib import Path

API = "{url}/api/v1"
SKILL_ID = "local-file-bridge"
MODEL_ID = "local-files-assistant"

SKILL_CONTENT = (Path(__file__).parent.parent / "skill" / "local-file-bridge.skill.md").read_text()
# strip YAML frontmatter — OWUI skill create takes name/description separately
if SKILL_CONTENT.startswith("---"):
    SKILL_CONTENT = SKILL_CONTENT.split("---", 2)[2].lstrip("\n")


def api(method, path, token, data=None):
    req = urllib.request.Request(
        f"{API[path.split('/')[0]]}{path[len(path.split('/')[0]):]}" if False else path,
        data=json.dumps(data).encode() if data else None,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method=method,
    )
    try:
        r = urllib.request.urlopen(req, timeout=30)
        return json.loads(r.read() or "{}")
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code} on {method} {path}: {e.read().decode()[:200]}")
        sys.exit(1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True, help="OWUI base URL, e.g. http://owui.internal:8080")
    ap.add_argument("--email", required=True)
    ap.add_argument("--password", required=True)
    ap.add_argument("--base-model", required=True, help="existing model id, e.g. glm-5.3-flash")
    args = ap.parse_args()
    globals()["API"] = f"{args.url}/api/v1"

    # 1. sign in
    tok = api("POST", f"{args.url}/api/v1/auths/signin",
              None, {"email": args.email, "password": args.password})["token"]
    print("✓ signed in")

    # 2. create/update skill (public) — idempotent: update if exists
    skill = {
        "id": SKILL_ID, "name": "Local File Bridge",
        "description": "Read/write files in the user's chosen local folder via the "
                       "File Bridge app (http://127.0.0.1:8765). Needs Code Interpreter.",
        "content": SKILL_CONTENT,
        "meta": {}, "is_active": True,
        "access_grants": [{"principal_type": "user", "principal_id": "*", "permission": "read"}],
    }
    existing = api("GET", f"{args.url}/api/v1/skills/", tok)
    if any(s.get("id") == SKILL_ID for s in existing):
        r = api("POST", f"{args.url}/api/v1/skills/id/{SKILL_ID}/update", tok, skill)
        print(f"✓ skill updated: {r.get('id')}")
    else:
        r = api("POST", f"{args.url}/api/v1/skills/create", tok, skill)
        print(f"✓ skill created: {r.get('id')}")
    api("POST", f"{args.url}/api/v1/skills/id/{SKILL_ID}/access/update", tok,
        {"access_grants": [{"principal_type": "user", "principal_id": "*", "permission": "read"}]})
    print("✓ skill public")

    # 3. create model preset — the two-switch gotcha:
    #    BOTH capabilities.code_interpreter AND defaultFeatureIds are required,
    #    otherwise the frontend never exposes execute_code to the model.
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
    models = api("GET", f"{args.url}/api/v1/models/export", tok)
    if any(m.get("id") == MODEL_ID for m in models):
        r = api("POST", f"{args.url}/api/v1/models/model/update", tok, model)
        print(f"✓ model preset updated: {r.get('id')} (base: {args.base_model})")
    else:
        r = api("POST", f"{args.url}/api/v1/models/create", tok, model)
        print(f"✓ model preset created: {r.get('id')} (base: {args.base_model})")
    print()
    print("Done. Users should now:")
    print("  1. Install & run File Bridge on their machine, pick a folder")
    print(f"  2. Select the '{MODEL_ID}' model in a new chat")
    print("  3. Ask for a file; click Allow on the browser's local-network prompt")


if __name__ == "__main__":
    main()
