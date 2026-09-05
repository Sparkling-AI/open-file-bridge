// Open File Bridge Connector — options page.
const BRIDGE_ORIGIN = "http://127.0.0.1:8765";

const tokenEl = document.getElementById("token");
const statusEl = document.getElementById("status");
const testOut = document.getElementById("testout");

chrome.storage.local.get(["bridgeToken"]).then((st) => {
  if (st.bridgeToken) tokenEl.value = st.bridgeToken;
});

document.getElementById("save").addEventListener("click", async () => {
  await chrome.storage.local.set({ bridgeToken: tokenEl.value.trim() });
  statusEl.textContent = "Saved.";
  setTimeout(() => (statusEl.textContent = ""), 2000);
});

document.getElementById("test").addEventListener("click", async () => {
  testOut.textContent = "Testing…";
  const headers = { "Content-Type": "application/json" };
  const st = await chrome.storage.local.get(["bridgeToken"]);
  if (st.bridgeToken) headers["X-Bridge-Token"] = st.bridgeToken;
  try {
    const r = await fetch(BRIDGE_ORIGIN + "/health", { headers });
    if (r.status === 401) {
      testOut.textContent = "Bridge is running but rejected the token (401). Check the token value.";
      return;
    }
    if (!r.ok) {
      testOut.textContent = "Bridge responded with HTTP " + r.status + ".";
      return;
    }
    const j = await r.json();
    testOut.textContent = "OK — bridge v" + (j.version || "?") + " is reachable.";
  } catch (e) {
    testOut.textContent = "Cannot reach the bridge. Is the Open File Bridge app running?";
  }
});
