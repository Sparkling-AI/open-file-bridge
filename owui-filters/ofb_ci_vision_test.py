"""Unit tests for ofb_ci_vision — run INSIDE the owui container:
docker cp + python (cwd /app/backend so `open_webui` imports resolve).
No DB/network needed: file-ref resolution is covered by the integration
step; here we monkeypatch _file_to_data_url where needed.
"""
import asyncio, base64, json, sys, types

sys.path.insert(0, "/tmp")
from ofb_ci_vision import Filter, MARKER  # noqa: E402

FAKE_B64 = base64.b64encode(b"X" * 300).decode()          # >= 256 chars
DATA_URL = f"data:image/png;base64,{FAKE_B64}"
PASS = []


def check(name, cond):
    PASS.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name)


def run(body, model=None, user=None):
    f = Filter()
    return asyncio.run(f.inlet(body, __user__=user or {"id": "u1", "role": "user"}, __model__=model))


def last_msg(body):
    return body["messages"][-1]


# t1: plain chat, no CI output — untouched
b = {"messages": [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "hello"}]}
r = run(b)
check("t1 plain chat untouched", r == b and len(r["messages"]) == 2)

# t2: CI output with bare data URL (the JSON-embedded case) — attached
ci_msg = {"role": "assistant", "content":
          "<code_interpreter>\nprint(1)\n</code_interpreter>\n"
          f"<code_interpreter_output>\n{{\"img\": \"{DATA_URL}\"}}\n</code_interpreter_output>"}
b = {"messages": [{"role": "user", "content": "show"}, ci_msg]}
r = run(b)
m = last_msg(r)
check("t2 synthetic appended", m["role"] == "user" and len(r["messages"]) == 3)
check("t2 marker present", m["content"][0]["text"].startswith(MARKER))
check("t2 image part", m["content"][1]["type"] == "image_url" and m["content"][1]["image_url"]["url"] == DATA_URL)

# t3: OWUI-rewritten file ref — resolved via monkeypatched loader
f = Filter()
async def fake_file(fid, user):
    return "data:image/jpeg;base64," + FAKE_B64
f._file_to_data_url = fake_file
ci2 = {"role": "assistant", "content":
       "<code_interpreter_output>\n![Output Image](/api/v1/files/0a1b2c3d-1111-2222-3333-444455556666/content)\n</code_interpreter_output>"}
b = {"messages": [{"role": "user", "content": "show"}, ci2]}
r = asyncio.run(f.inlet(b, __user__={"id": "u1", "role": "user"}, __model__=None))
check("t3 file ref attached", last_msg(r)["content"][1]["image_url"]["url"].endswith(FAKE_B64[:20]))

# t4: markdown data URL gets its label; dedupe with bare occurrence
ci3 = {"role": "assistant", "content":
       f"<code_interpreter_output>\n![site.jpg](data:image/png;base64,{FAKE_B64})\nalso {DATA_URL}\n</code_interpreter_output>"}
b = {"messages": [ci3]}
r = run(b)
imgs = [p for p in last_msg(r)["content"] if p.get("type") == "image_url"]
check("t4 dedupe to one image", len(imgs) == 1)
check("t4 label from markdown", "site.jpg" in last_msg(r)["content"][0]["text"])

# t5: stale synthetic message stripped, then re-attached fresh
stale = {"role": "user", "content": [{"type": "text", "text": MARKER + " old note"},
                                     {"type": "image_url", "image_url": {"url": "data:image/png;base64,OLDOLD"}}]}
b = {"messages": [{"role": "user", "content": "q"}, stale, ci_msg.copy()]}
r = run(b)
check("t5 stale stripped", sum(1 for m in r["messages"] if isinstance(m.get("content"), list) and
                               any(p.get("type") == "text" and str(p.get("text", "")).startswith(MARKER) for p in m["content"] if isinstance(p, dict)) and m is not last_msg(r)) == 0)
check("t5 fresh appended", last_msg(r)["content"][0]["text"].startswith(MARKER))

# t6: max_images cap
f = Filter()
f.valves.max_images = 1
b64b = base64.b64encode(b"Y" * 300).decode()
ci4 = {"role": "assistant", "content":
       f"<code_interpreter_output>\n{DATA_URL}\ndata:image/png;base64,{b64b}\n</code_interpreter_output>"}
b = {"messages": [ci4]}
r = asyncio.run(f.inlet(b, __user__={"id": "u1"}, __model__=None))
check("t6 capped at 1", len([p for p in last_msg(r)["content"] if p.get("type") == "image_url"]) == 1)

# t7: size gate — tiny cap skips everything, body untouched
f = Filter()
f.valves.max_image_mb = 0.000001
b = {"messages": [ci_msg.copy()]}
r = asyncio.run(f.inlet(b, __user__={"id": "u1"}, __model__=None))
check("t7 oversize skipped", len(r["messages"]) == 1)

# t8: model gate off + explicit vision=False skips
f = Filter()
f.valves.inject_for_all_models = False
model = {"info": {"meta": {"capabilities": {"vision": False}}}}
b = {"messages": [ci_msg.copy()]}
r = asyncio.run(f.inlet(b, __user__={"id": "u1"}, __model__=model))
check("t8 vision=False skips", len(r["messages"]) == 1)

# t9: internal error -> passthrough
f = Filter()
async def boom(body, user, model):
    raise RuntimeError("boom")
f._process = boom
b = {"messages": [{"role": "user", "content": "x"}]}
r = asyncio.run(f.inlet(b))
check("t9 error passthrough", r == b)

# t10: image regex must NOT fire on text outside <code_interpreter_output>
b = {"messages": [{"role": "assistant", "content": f"answer:\n{DATA_URL}"}]}
r = run(b)
check("t10 outside CI output ignored", len(r["messages"]) == 1)

# t11: open_webui imports resolve in container env (file-ref path viability)
try:
    from open_webui.models.files import Files
    from open_webui.storage.provider import Storage
    ok = True
except Exception as e:
    ok = False
    print("  import error:", e)
check("t11 open_webui imports", ok)

failed = [n for n, c in PASS if not c]
print(f"\n{len(PASS) - len(failed)}/{len(PASS)} passed")
sys.exit(1 if failed else 0)
