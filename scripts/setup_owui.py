#!/usr/bin/env python3
"""One-shot server-side setup for admins: creates the public Skill + the
model preset on an Open WebUI instance via its REST API. Verified against
Open WebUI v0.11.1.

The script reads the skill body from skill/open-file-bridge/SKILL.md
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
      [--variant standard|strict]    # skill flavor; default standard
      [--variant-strict-model ID]    # ALSO create a strict preset on
                                     # this (weak) model; implies both
                                     # skills being installed
      [--bridge-token SECRET]        # opt-in Tier 2: org-wide token
"""
import argparse
import difflib
import json
import re
import sys
import urllib.request
from pathlib import Path

SKILL_ID = "open-file-bridge"
MODEL_ID = "local-files-assistant"
STRICT_SKILL_ID = "open-file-bridge-strict"
STRICT_MODEL_ID = "local-files-assistant-strict"
# Skill description, shared by BOTH variants (standard + strict).
# Models are only guaranteed to SEE the name+description (tool list);
# opening the body is optional. The failure-mode wording is what makes
# weak models actually call the skill — validated on glm-4.5-air
# 2026-08-28 (fabrication → full bridge flow /list→/read→/write with
# this exact text), and re-validated on glm-5.3 with the same text on
# the standard skill (no regression for strong models). See ROADMAP
# multi-model smoke + references/multi-model-smoke.md.
UNIFIED_DESC = (
    "MUST-CALL before ANY file task. User's real files are reachable "
    "ONLY via the local bridge (http://127.0.0.1:8765) — call this "
    "skill first and run its Bootstrap. Files written with open()/os "
    "in this sandbox are LOST and INVISIBLE to the user; claiming "
    "success without a bridge response is a failure.")
SKILL_DIR = "skill/open-file-bridge"
# keep in sync with VERSION/SKILL_VERSION in src/file_bridge.py and the
# skill folder's CHANGELOG.md
SKILL_VERSION = "2.7"
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


def upsert_skill(base, tok, skill_id, name, description, skill_md, yes):
    """Create or diff-preview-update one skill; returns True if the live
    body now equals skill_md."""
    skill = {
        "id": skill_id, "name": name,
        "description": description,
        "content": skill_md,
        "meta": {}, "is_active": True,
        "access_grants": [{"principal_type": "user", "principal_id": "*",
                           "permission": "read"}],
    }
    existing = api("GET", f"{base}/api/v1/skills/", tok)
    # the LIST endpoint omits `content` — fetch the full record by id
    live = next((s for s in existing if s.get("id") == skill_id), None)
    if live is not None:
        full = api("GET", f"{base}/api/v1/skills/id/{skill_id}", tok)
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
                fromfile=f"live skill ({skill_id})",
                tofile=f"new skill ({SKILL_VERSION})",
                n=1,
            )
            dlines = list(diff)
            print(f"--- {skill_id} body diff ({len([l for l in dlines if l.startswith(('+', '-')) and not l.startswith(('+++', '---'))])} changed lines) ---")
            for line in dlines[:80]:
                print("  " + line.rstrip())
            if len(dlines) > 80:
                print(f"  … ({len(dlines) - 80} more diff lines)")
            print("--- end diff ---")
            if not yes:
                try:
                    ans = input(f"Apply this update to {skill_id}? [y/N] ")
                except EOFError:
                    ans = ""
                if ans.strip().lower() not in ("y", "yes"):
                    print(f"⏭ {skill_id} NOT updated")
                    return False
        r = api("POST", f"{base}/api/v1/skills/id/{skill_id}/update", tok, skill)
        print(f"✓ skill updated: {r.get('id')}")
    else:
        r = api("POST", f"{base}/api/v1/skills/create", tok, skill)
        print(f"✓ skill created: {r.get('id')}")
    api("POST", f"{base}/api/v1/skills/id/{skill_id}/access/update", tok,
        {"access_grants": [{"principal_type": "user", "principal_id": "*",
                            "permission": "read"}]})
    print(f"✓ {skill_id} public")
    return True


def load_skill_md(fname, bridge_token):
    skill_md = (REPO / SKILL_DIR / fname).read_text()
    if skill_md.startswith("---"):
        skill_md = skill_md.split("---", 2)[2].lstrip("\n")
    if bridge_token:
        inject = (
            '# Org token (Tier 2): every bridge call — GET included — MUST\n'
            '# send these headers. Use this BRIDGE_HEADERS verbatim in the\n'
            '# bootstrap helpers; do NOT redefine it.\n'
            'BRIDGE_HEADERS = {"Content-Type": "application/json",\n'
            '                  "X-Bridge-Token": "%s"}\n' % bridge_token
        )
        # SKILL.md and SKILL-STRICT.md use different bootstrap headings —
        # try both anchors before falling back to a prepend
        for anchor in (r"## Bootstrap helpers \(run once per session\)\n",
                       r"## Bootstrap — run this first, copy it exactly\n"):
            skill_md, n = re.subn(r"(" + anchor + r")",
                                  r"\1\n" + inject, skill_md, count=1)
            if n == 1:
                return skill_md
        skill_md = inject + "\n" + skill_md  # fallback: prepend
    return skill_md


def upsert_model(base, tok, model_id, name, base_model, skill_ids):
    # the two-switch gotcha: BOTH capabilities.code_interpreter AND
    # defaultFeatureIds are required, or the frontend silently sends
    # features.code_interpreter:false.
    model = {
        "id": model_id, "base_model_id": base_model, "name": name,
        "meta": {
            "description": "Access your own local files through the Open File Bridge app.",
            "capabilities": {"code_interpreter": True},
            "defaultFeatureIds": ["code_interpreter"],
            "skillIds": skill_ids,
        },
        "params": {},
        "access_grants": [{"principal_type": "user", "principal_id": "*",
                           "permission": "read"}],
        "is_active": True,
    }
    models = api("GET", f"{base}/api/v1/models/export", tok)
    if any(m.get("id") == model_id for m in models):
        r = api("POST", f"{base}/api/v1/models/model/update", tok, model)
        print(f"✓ model preset updated: {r.get('id')}")
    else:
        r = api("POST", f"{base}/api/v1/models/create", tok, model)
        print(f"✓ model preset created: {r.get('id')}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True, help="OWUI base URL, e.g. http://owui.internal:8080")
    ap.add_argument("--email", required=True)
    ap.add_argument("--password", required=True)
    ap.add_argument("--base-model", required=True, help="existing model id, e.g. glm-5.3-flash")
    ap.add_argument("--variant", choices=["standard", "strict"],
                    default="standard",
                    help="skill flavor to install as the main skill: "
                         "standard (capable models, default) or strict "
                         "(fixed recipes + verify-after-write, for weaker "
                         "models; created as its own skill either way)")
    ap.add_argument("--variant-strict-model", default=None, metavar="ID",
                    help="additionally create a strict preset on this "
                         "(weaker) base model — implies installing the "
                         "strict skill alongside the standard one")
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

    # 2. skills — variant selection (both files ship in the repo; users
    #    keep whichever they don't install for later customization)
    std_md = load_skill_md("SKILL.md", args.bridge_token)
    strict_md = load_skill_md("SKILL-STRICT.md", args.bridge_token)
    installed = []
    if args.variant == "strict":
        if upsert_skill(base, tok, STRICT_SKILL_ID,
                        "Open File Bridge (strict)",
                        UNIFIED_DESC,
                        strict_md, args.yes):
            installed.append(STRICT_SKILL_ID)
    else:
        if upsert_skill(base, tok, SKILL_ID, "Open File Bridge",
                        UNIFIED_DESC,
                        std_md, args.yes):
            installed.append(SKILL_ID)
    if args.variant_strict_model:
        # the strict preset needs the strict skill installed
        if STRICT_SKILL_ID not in installed:
            if upsert_skill(base, tok, STRICT_SKILL_ID,
                            "Open File Bridge (strict)",
                            UNIFIED_DESC,
                            strict_md, args.yes):
                installed.append(STRICT_SKILL_ID)

    # 3. model preset(s) — two-switch gotcha handled inside upsert_model
    if args.variant == "strict":
        upsert_model(base, tok, MODEL_ID, "Local Files Assistant",
                     args.base_model, installed)
    else:
        upsert_model(base, tok, MODEL_ID, "Local Files Assistant",
                     args.base_model, installed)
        if args.variant_strict_model:
            upsert_model(base, tok, STRICT_MODEL_ID,
                         "Local Files Assistant (strict)",
                         args.variant_strict_model, [STRICT_SKILL_ID])
            print(f"  (strict preset rides on '{args.variant_strict_model}'; "
                  f"standard preset on '{args.base_model}')")

    # 4. code interpreter engine (admin default) — read current, warn only
    ci = api("GET", f"{base}/api/v1/configs/code_execution", tok)
    if not ci.get("ENABLE_CODE_INTERPRETER") or ci.get("CODE_INTERPRETER_ENGINE") != "pyodide":
        print("⚠ Admin Settings → Code Execution: enable Code Interpreter with the "
              "Pyodide engine (current: %s)" % ci.get("CODE_INTERPRETER_ENGINE"))
    else:
        print("✓ code interpreter: pyodide engine enabled")

    print()
    print("Done. Users should now:")
    print("  1. Install & run Open File Bridge on their machine, pick a folder")
    print(f"  2. Select the '{MODEL_ID}' model in a new chat")
    print("  3. Ask for a file; click Allow on the browser's local-network prompt")


if __name__ == "__main__":
    main()
