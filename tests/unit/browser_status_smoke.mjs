#!/usr/bin/env node
// Browser regressions for status meaning, native-API outcomes and approval
// acknowledgments. Native permission/clipboard and transport failures are
// simulated; the shipped scripts, rendered DOM and computed colors are real.
// node tests/unit/browser_status_smoke.mjs <extension-dir>
import { chromium } from "playwright";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ext = process.argv[2];
if (!ext) throw new Error("usage: browser_status_smoke.mjs <extension-dir>");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ofb-status-"));
const ctx = await chromium.launchPersistentContext(profile, {
  channel: process.env.OFB_BROWSER_CHANNEL || "chromium", headless: true,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
let checks = 0;
const colors = { ok: "rgb(10, 125, 50)", hint: "rgb(102, 102, 102)",
  warn: "rgb(187, 0, 0)", caution: "rgb(138, 75, 8)" };
try {
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker", { timeout: 10000 });
  const p = await ctx.newPage();
  const errors = [];
  p.on("pageerror", e => errors.push(String(e)));
  await p.goto(sw.url().replace("sw.js", "options.html"));
  await p.waitForFunction(() => !!document.getElementById("tokenset").onclick);
  await p.waitForFunction(() => document.querySelectorAll("#langbox input").length > 1);
  const tone = async (id, expected) => {
    await p.waitForFunction(({ id, expected }) => document.getElementById(id).className === expected,
      { id, expected });
    const color = await p.locator("#" + id).evaluate(el => getComputedStyle(el).color);
    assert.equal(color, colors[expected], `${id} computed color`);
    checks++;
  };

  await p.evaluate(async () => {
    await OFBIDB.put("kv", "http://localhost:8080", "allowed_site");
    chrome.scripting.getRegisteredContentScripts = async () => [{ id: "ofb-inject" }];
    setSiteStatus("");
    await renderSec();
  });
  await tone("sitestat", "ok");
  assert.equal(await p.locator("#secmodeinfo .warn, #secmodeinfo .caution").count(), 0);
  checks++;
  await p.evaluate(async () => {
    await OFBIDB.put("kv", "https://chat.example.com", "allowed_site"); await renderSec();
  });
  assert.equal(await p.locator("#secmodeinfo .caution").count(), 1);
  checks++;

  await p.locator("#bridgetoken").fill("short"); await p.locator("#tokenset").click();
  await tone("tokenstat", "warn");
  await p.locator("#bridgetoken").fill("test-only-token"); await p.locator("#tokenset").click();
  await tone("tokenstat", "ok");
  await p.evaluate(() => Object.defineProperty(navigator, "clipboard", {
    configurable: true, value: { writeText: async () => { throw new Error("clipboard unavailable"); } },
  }));
  await p.locator("#tokencopy").click(); await tone("tokenstat", "warn");
  await p.evaluate(() => Object.defineProperty(navigator, "clipboard", {
    configurable: true, value: { writeText: async () => {} },
  }));
  await p.locator("#tokencopy").click(); await tone("tokenstat", "ok");
  await p.locator("#tokengen").click(); await tone("tokenstat", "hint");
  await p.locator("#bridgetoken").fill(""); await p.locator("#tokenset").click();
  await tone("tokenstat", "hint");

  await p.locator("#confirmscope").selectOption("off"); await tone("confirmstat", "caution");
  assert.match(await p.locator("#confirmstat").textContent(), /Confirmations are off/);
  await p.evaluate(() => refresh()); await tone("confirmstat", "caution");
  await p.locator("#confirmscope").selectOption("all"); await tone("confirmstat", "ok");

  await p.evaluate(() => {
    document.querySelectorAll("#langbox input").forEach(el => { el.checked = false; });
    document.getElementById("langbox").dispatchEvent(new Event("change", { bubbles: true }));
  });
  await tone("langs", "warn");
  await p.evaluate(() => {
    const original = pipe;
    window.failOcr = true;
    pipe = (...args) => args[1] === "/ocr/lang" && window.failOcr
      ? Promise.resolve({ ok: false, error: "OCR save failed", data: {} }) : original(...args);
  });
  await p.locator('#langbox input[value="swe"]').check();
  await p.waitForFunction(() => document.getElementById("langs").textContent.includes("OCR save failed"));
  await tone("langs", "warn");
  await p.evaluate(() => { window.failOcr = false; });
  await p.locator('#langbox input[value="deu"]').check(); await tone("langs", "ok");

  // Use a real OPFS handle, mocking only the native picker and its outcome.
  for (const permission of ["prompt", "denied", "granted"]) {
    await p.evaluate(async permission => {
      const root = await navigator.storage.getDirectory();
      const h = await root.getDirectoryHandle("fixture-" + permission, { create: true });
      h.queryPermission = async () => permission;
      window.showDirectoryPicker = async () => h;
    }, permission);
    await p.locator("#pick").click();
    await p.waitForFunction(permission => document.getElementById("folderstatus").textContent.includes("fixture-" + permission), permission);
    await tone("folderstatus", permission === "granted" ? "ok" : "caution");
  }
  if (process.env.OFB_UI_SCREENSHOT_DIR) {
    fs.mkdirSync(process.env.OFB_UI_SCREENSHOT_DIR, { recursive: true });
    await p.locator("#sec-security").screenshot({
      path: path.join(process.env.OFB_UI_SCREENSHOT_DIR, "security.png"),
    });
  }
  assert.deepEqual(errors, []);

  // Load the actual confirmation renderer with a simulated Chrome transport.
  // CDP inspects its closed shadow root without weakening production isolation.
  const popup = await ctx.newPage();
  await popup.setContent("<!doctype html><title>Status fixture</title>");
  await popup.evaluate(() => {
    window.chrome = { runtime: {
      getURL: () => "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=",
      lastError: null, onMessage: { addListener: fn => { window.ask = fn; } },
      sendMessage: (_msg, callback) => { window.verdictCallback = callback; },
    } };
  });
  const cdp = await ctx.newCDPSession(popup);
  async function shadowNode(className) {
    const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    function find(node) {
      const attrs = node.attributes || [];
      const index = attrs.indexOf("class");
      if (index >= 0 && attrs[index + 1].split(" ").includes(className)) return node;
      for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) {
        const hit = find(child); if (hit) return hit;
      }
    }
    const node = find(root); assert.ok(node, className + " exists");
    return (await cdp.send("DOM.resolveNode", { nodeId: node.nodeId })).object.objectId;
  }
  async function verdict() {
    const objectId = await shadowNode("verdict");
    return (await cdp.send("Runtime.callFunctionOn", {
      objectId, functionDeclaration: "function(){return {text:this.textContent,color:getComputedStyle(this).color,classes:this.parentElement.className}}",
      returnByValue: true,
    })).result.value;
  }
  for (const outcome of ["approved", "rejected", "missing", "runtime-error", "throw"]) {
    await popup.evaluate(() => {
      document.getElementById("ofb-confirm-root")?.remove();
    });
    // Recreate the renderer in the same page for deterministic transport cases.
    await popup.evaluate(() => { delete window.__ofbConfirmHost; });
    await popup.addScriptTag({ content: fs.readFileSync(path.join(ext, "confirm.js"), "utf8") });
    await popup.evaluate(outcome => {
      chrome.runtime.lastError = null;
      chrome.runtime.sendMessage = (_msg, callback) => {
        if (outcome === "throw") throw new Error("extension unavailable");
        window.verdictCallback = callback;
      };
      window.ask({ ofbConfirm: true, id: "test-" + outcome, op: "delete", summary: "delete fixture.txt" });
    }, outcome);
    const objectId = await shadowNode("approve");
    await cdp.send("Runtime.callFunctionOn", { objectId, functionDeclaration: "function(){this.click()}" });
    if (outcome !== "throw") {
      const pending = await verdict();
      assert.match(pending.text, /Recording approval/);
      assert.ok(!pending.classes.split(" ").includes("ok"), "no success before acknowledgment");
      await popup.evaluate(outcome => {
        if (outcome === "runtime-error") chrome.runtime.lastError = { message: "worker unavailable" };
        window.verdictCallback(outcome === "approved" ? { ok: true } :
          outcome === "rejected" ? { ok: false, error: "expired confirmation" } : undefined);
      }, outcome);
    }
    const result = await verdict();
    assert.equal(result.color, outcome === "approved" ? colors.ok : colors.warn, outcome);
    assert.ok(result.classes.split(" ").includes(outcome === "approved" ? "ok" : "error"));
    if (process.env.OFB_UI_SCREENSHOT_DIR) {
      // The renderer's finite entrance animation is inside a closed root.
      await popup.waitForTimeout(250);
      await popup.screenshot({ animations: "disabled",
        path: path.join(process.env.OFB_UI_SCREENSHOT_DIR, outcome + ".png") });
    }
    checks++;
  }
  console.log(`STATUS BROWSER SMOKE PASS: ${checks} status checks`);
} finally {
  await ctx.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
