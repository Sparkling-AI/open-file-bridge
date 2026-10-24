// Open File Bridge — runtime-registered sandbox injector (spike, 2026-10-23).
//
// Registered DYNAMICALLY by the service worker (chrome.scripting.
// registerContentScripts) for the ONE origin the user set as their
// allowed site — never statically in the manifest, so the extension
// declares no broad https match at install time. Same guard + exports
// as the pilot org's tested design (b):
//   https://…/OFB_CLIENT_INJECTION_FINDINGS.md
//   - runs ONLY in a sandboxed srcdoc frame: not top, about:srcdoc,
//     self.origin === "null"
//   - defines frozen ofb.fetch + OFB_CLIENT_PY before any page script
//   - capture-phase message listener swallows relay replies that carry
//     THIS frame's id prefix, so stock Open WebUI's sandbox host never
//     sees them as code (stdout wipe fix)
//   - no chrome.*, no secrets
(function () {
  "use strict";
  if (window !== window.top) {
    if (location.href !== "about:srcdoc" || self.origin !== "null") return;
  } else {
    return;
  }
  if (typeof globalThis.ofb !== "undefined") return; // already injected

  var VER = "3.7.0-inj";
  var PREFIX = "ofbj-" + Math.random().toString(16).slice(2, 14);

  var pending = new Map();   // id -> resolve
  var n = 0;

  // reply interception — capture phase, BEFORE the sandbox host's own
  // listener (registered later): replies to OUR ids never reach it
  addEventListener("message", function (ev) {
    if (ev.source !== window.parent) return;
    var d = ev.data;
    if (!d || d.ofb !== true || typeof d.id !== "string") return;
    if (d.id.indexOf(PREFIX) !== 0) return;   // legacy bootstrap ids pass through
    ev.stopImmediatePropagation();
    var res = pending.get(d.id);
    if (res) {
      pending.delete(d.id);
      res({
        ok: d.ok === true, status: d.status,
        body: d.body || null, bodyB64: d.bodyB64 || null,
        error: d.error || null, truncated: d.truncated === true,
      });
    }
  }, true); // capture

  function fetch_(method, path, body, b64, token, timeoutMs) {
    var id = PREFIX + "-" + (n++);
    var ms = Math.min(600000, Math.max(1000, Number(timeoutMs) || 45000));
    return new Promise(function (resolve) {
      var done = false;
      pending.set(id, function (v) {
        if (done) return; done = true; pending.delete(id); resolve(v);
      });
      var msg = { ofb: true, id: id, method: String(method), path: String(path) };
      if (body !== null && body !== undefined && body !== "") msg.body = String(body);
      if (b64 === true) msg.b64 = true;
      if (token) msg.token = String(token);
      parent.postMessage(msg, "*");
      setTimeout(function () {
        if (done) return; done = true; pending.delete(id);
        resolve({ ok: false, status: 0, timeout: true,
          error: String(path) + ": no reply in " + Math.round(ms / 1000) +
            " s — the extension tab may need a reload" });
      }, ms);
    });
  }

  function define(name, value) {
    try {
      Object.defineProperty(globalThis, name, {
        value: value, writable: false, configurable: false,
      });
    } catch (e) { /* best effort */ }
  }

  define("__ofbInjected", VER);
  define("ofb", Object.freeze({
    version: VER,
    fetch: function (method, path, body, b64, token, timeoutMs) {
      return fetch_(method, path, body, b64, token, timeoutMs);
    },
  }));
  // OFB_CLIENT_PY is appended at BUILD time by scripts/build_inject.py
  // (embeds ofb-client.py as a JSON string literal).
  define("OFB_CLIENT_PY", "\"\"\"Open File Bridge \u2014 Pyodide client (ofb_client) 3.7.0-inj.\n\nSame helpers as the SKILL-EXT bootstrap, refactored for injection:\nexec()'d from js.OFB_CLIENT_PY inside Open WebUI's sandbox iframe.\nDifferences from the pasted bootstrap:\n  - ofb_init(token=None) replaces the top-level `await bridge_get(\"/health\")`\n    (exec() cannot run top-level awaits; the cell itself runs under\n    runPythonAsync, so `await ofb_init(...)` works).\n  - transport \"js\": awaits js.ofb.fetch(...) \u2014 the MAIN-world transport\n    the extension registers at document_start. Falls back to the exact\n    3.3.x postMessage pipe when absent (worker executor, older ext).\nNothing here is a secret: the token arrives per call from the cell.\n\"\"\"\n\nimport json, base64, asyncio, random, urllib.parse, io, zipfile, sysconfig\nimport js\nfrom pyodide.ffi import create_proxy, to_js\ntry:\n    from js import parent            # iframe sandbox; absent in a worker\nexcept ImportError:\n    parent = None\n\nOFB_CLIENT_VERSION = \"3.7.0-inj\"\n_TOKEN = [\"\"]\n_S = {\"pending\": {}, \"n\": 0, \"bc\": None, \"relay\": None, \"roots\": [],\n      \"wid\": \"w%08x\" % random.getrandbits(32), \"transport\": None}\n\n\nclass BridgeError(RuntimeError):\n    pass\n\n\ndef ofb_set_token(t):\n    _TOKEN[0] = str(t or \"\")\n\n\ndef _js(d):                          # plain JS object, never a Map\n    try:\n        return to_js(d, dict_converter=js.Object.fromEntries)\n    except Exception:\n        return js.JSON.parse(json.dumps(d))\n\n\ndef _on_msg(ev):\n    try:\n        d = ev.data.to_py()\n        if d.get(\"ofb\") is not True or d.get(\"method\") is not None or \"ok\" not in d:\n            return                   # only RESPONSES resolve futures\n        f = _S[\"pending\"].pop(d.get(\"id\"), None)\n        if f is not None and not f.done():\n            f.set_result(d)\n    except Exception:\n        pass\n\n\ndef _install():\n    if _S.get(\"on\"):\n        return\n    js.addEventListener(\"message\", create_proxy(_on_msg))\n    try:\n        _S[\"bc\"] = js.BroadcastChannel.new(\"ofb-pipe\")\n        _S[\"bc\"].addEventListener(\"message\", create_proxy(_on_msg))\n    except Exception:\n        _S[\"bc\"] = None\n    _S[\"on\"] = True\n\n\nasync def _elect(wait=0.25):\n    tags = []\n\n    def hello(ev):\n        try:\n            d = ev.data.to_py()\n            if d.get(\"ofbRelay\") is True and d.get(\"workerId\") == _S[\"wid\"]:\n                tags.append(d.get(\"tag\"))\n        except Exception:\n            pass\n    p = create_proxy(hello)\n    _S[\"bc\"].addEventListener(\"message\", p)\n    _S[\"bc\"].postMessage(_js({\"ofbHello\": True, \"workerId\": _S[\"wid\"]}))\n    await asyncio.sleep(wait)\n    _S[\"bc\"].removeEventListener(\"message\", p)\n    _S[\"relay\"] = min(tags) if tags else None\n\n\nasync def _fetch_js(method, path, body, b64, timeout):\n    # js.ofb.fetch is an awaitable JsProxy; resolve through asyncio\n    fut = asyncio.get_event_loop().create_future()\n    try:\n        jp = js.ofb.fetch(method, path,\n                          body,               # None -> JS null/undefined\n                          bool(b64), _TOKEN[0],\n                          int(timeout * 1000))\n        res = await jp\n        d = res.to_py() if hasattr(res, \"to_py\") else dict(res)\n        return d\n    except Exception as e:\n        raise BridgeError(str(e))\n\n\nasync def ofb_fetch(method, path, body=None, b64=False, timeout=45.0):\n    _install()\n    use_js = (_S.get(\"transport\") != \"pm\") and getattr(js, \"ofb\", None) is not None\n    if use_js:\n        return await _fetch_js(method, path, body, b64, timeout)\n    # legacy pipe (3.3.x shape) \u2014 worker executor / older extension\n    rid = '%s-%d' % (_S[\"wid\"], _S[\"n\"]); _S[\"n\"] += 1\n    fut = asyncio.get_event_loop().create_future()\n    _S[\"pending\"][rid] = fut\n    msg = {\"ofb\": True, \"id\": rid, \"method\": method, \"path\": path}\n    if body is not None: msg[\"body\"] = body\n    if _TOKEN[0]: msg[\"token\"] = _TOKEN[0]\n    if b64: msg[\"b64\"] = True\n    if parent is not None:\n        parent.postMessage(_js(msg), \"*\")\n    else:\n        if _S[\"bc\"] is None:\n            raise BridgeError(\"no transport (worker without BroadcastChannel)\")\n        if _S[\"relay\"] is None:\n            await _elect()\n        if _S[\"relay\"] is None:\n            _S[\"pending\"].pop(rid, None)\n            raise BridgeError(\"Open File Bridge extension not present on this page (no relay answered)\")\n        msg[\"to\"] = _S[\"relay\"]\n        _S[\"bc\"].postMessage(_js(msg))\n    try:\n        return await asyncio.wait_for(fut, timeout)\n    except asyncio.TimeoutError:\n        _S[\"pending\"].pop(rid, None); _S[\"relay\"] = None\n        raise BridgeError(f\"{path.split('?')[0]}: no reply in {timeout:.0f} s \u2014 retry once; narrow the request (a path=, fewer files)\")\n\n\ndef _url(path, params=None):\n    if not params:\n        return path\n    return path + \"?\" + \"&\".join(f\"{k}={urllib.parse.quote(str(v), safe='/')}\" for k, v in params.items())\n\n\nclass BridgeError_with_info(BridgeError):\n    \"\"\"BridgeError whose .info carries the full parsed error body and\n    .status the HTTP number (pilot 3.7.0 blocker 5).\"\"\"\n    def __init__(self, msg, info, status=None):\n        super().__init__(msg)\n        self.info = info\n        self.status = status\n\n\ndef _check(path, d, key=\"body\"):\n    \"\"\"Raise BridgeError on any non-200. The message carries a BOUNDED\n    excerpt; the full parsed error body rides on .info so batch results\n    and long hints are never lost.\"\"\"\n    if d.get(\"status\") == 200 and key in d:\n        return\n    info = d.get(\"error\") or \"\"\n    if d.get(\"body\"):\n        try: info = json.loads(d[\"body\"])\n        except Exception: info = d[\"body\"][:400]\n    msg = f\"{path} -> HTTP {d.get('status')}: {json.dumps(info, ensure_ascii=False)[:700]}\"\n    raise BridgeError_with_info(msg, info, d.get(\"status\"))\n\n\nasync def bridge_get(path, params=None, timeout=45.0):\n    d = await ofb_fetch(\"GET\", _url(path, params), timeout=timeout)\n    _check(path, d)\n    return json.loads(d[\"body\"])\n\n\nasync def bridge_post(path, payload, timeout=45.0):\n    d = await ofb_fetch(\"POST\", path, json.dumps(payload), timeout=timeout)\n    _check(path, d)\n    return json.loads(d[\"body\"])\n\n\nasync def ofb_fetch_b64(path, timeout=45.0):\n    d = await ofb_fetch(\"GET\", path, b64=True, timeout=timeout)\n    _check(path, d, \"bodyB64\")\n    return base64.b64decode(d[\"bodyB64\"])\n\n\nasync def read_binary(path):\n    \"\"\"Whole-file read. 413 (over the b64 cap) falls back to a range\n    loop (pilot 3.7.0 blocker 4) so a 9 MB log no longer needs manual\n    read_binary_range plumbing.\"\"\"\n    try:\n        return base64.b64decode((await bridge_get(\"/read_b64\", {\"path\": path}))[\"b64\"])\n    except BridgeError_with_info as e:\n        if getattr(e, \"status\", None) != 413:\n            raise\n        st = e.info.get(\"size_bytes\") if isinstance(e.info, dict) else None\n        if not st:\n            raise\n        chunks = []\n        off = 0\n        while off < st:\n            chunks.append(await read_binary_range(path, off, min(4_000_000, st - off)))\n            off += min(4_000_000, st - off)\n        return b\"\".join(chunks)\n\n\nasync def read_binary_range(path, offset, length):\n    return base64.b64decode((await bridge_get(\n        \"/read_b64\", {\"path\": path, \"offset\": int(offset), \"length\": int(length)}))[\"b64\"])\n\n\nasync def read_text(path, encoding=\"utf-8-sig\"):\n    return (await read_binary(path)).decode(encoding, \"replace\")\n\n\nasync def write_text(path, text):\n    return await bridge_post(\"/write\", {\"path\": path, \"content\": text})\n\n\nasync def write_binary(path, data):\n    return await bridge_post(\"/write_b64\", {\"path\": path, \"b64\": base64.b64encode(data).decode()})\n\n\nasync def install_bridge_wheels(*prefixes):\n    sp = sysconfig.get_paths()[\"purelib\"]; got = []\n    for name in (await bridge_get(\"/wheels\"))[\"wheels\"]:\n        if not prefixes or any(name.lower().startswith(p.lower()) for p in prefixes):\n            zipfile.ZipFile(io.BytesIO(await ofb_fetch_b64(\"/wheels/\" + name))).extractall(sp)\n            got.append(name)\n    return got\n\n\ndef bridge_path(p):\n    parts = [x for x in str(p).replace(\"\\\\\", \"/\").split(\"/\") if x and x != \".\"]\n    roots = _S[\"roots\"]\n    for i in range(len(parts)):\n        hit = [r for r in roots if parts[i].lower() in {\n            str(r.get(\"alias\") or \"\").lower(), str(r.get(\"path\") or \"\").lower(),\n            str(r.get(\"id\")).lower()}]\n        if hit:\n            rest = \"/\".join(parts[i + 1:])\n            return (hit[0][\"id\"] + \"/\" + rest).rstrip(\"/\") if len(roots) > 1 else rest\n    if parts and (len(parts[0]) == 2 and parts[0][1] == \":\"):\n        raise BridgeError(f\"no shared folder contains {p!r} \u2014 shared roots: \"\n                          f\"{[r.get('alias') or r.get('id') for r in roots]}\")\n    return \"/\".join(parts)\n\n\ndef out(obj, limit=4000):\n    s = obj if isinstance(obj, str) else json.dumps(obj, ensure_ascii=False, default=str)\n    print(s if len(s) <= limit else s[:limit] + f\" \u2026[+{len(s) - limit} chars cut \u2014 print a smaller slice]\")\n\n\nasync def ofb_init(token=None, transport=\"auto\", quiet=False):\n    \"\"\"First line of a chat: import js; exec(js.OFB_CLIENT_PY);\n    await ofb_init(\"<bridge token>\"). Calls /health, remembers the\n    roots and prints a one-line summary. transport: \"auto\" (js pipe\n    when present), \"js\" (injection only), \"pm\" (legacy pipe only).\"\"\"\n    if token:\n        ofb_set_token(token)\n    if transport in (\"js\", \"pm\"):\n        _S[\"transport\"] = transport\n    h = await bridge_get(\"/health\")\n    _S[\"roots\"] = h.get(\"roots\") or []\n    if not quiet:\n        out({\"version\": h.get(\"version\"),\n             \"client\": OFB_CLIENT_VERSION,\n             \"roots\": [{\"id\": r.get(\"id\"), \"name\": r.get(\"alias\") or r.get(\"path\"),\n                        \"perm\": r.get(\"perm\")} for r in _S[\"roots\"]],\n             \"helpers\": \"ready\"})\n    return h\n");
})();
