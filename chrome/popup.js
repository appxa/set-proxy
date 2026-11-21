"use strict";

const $ = (id) => document.getElementById(id);
let state = { proxies: [], activeId: null, proxyOn: false, autoChange: false, autoChangeTimeout: 30000, pingTimeout: 10000, bypass: [], pingResults: {} };
// Ping cells for the currently rendered rows, keyed by proxy id.
const pingEls = new Map();

function send(msg) {
  return chrome.runtime.sendMessage(msg);
}

function setMsg(el, text, kind) {
  el.textContent = text || "";
  el.classList.remove("ok", "bad");
  if (kind) el.classList.add(kind);
}

function shortErr(e) {
  return e ? String(e).split(" ")[0] : "failed";
}

function activeProxy() {
  return state.proxies.find((p) => p.id === state.activeId) || null;
}

// ---- add form ----
function currentFormCfg() {
  return {
    type: $("proxyType").value,
    host: $("proxyHost").value.trim(),
    port: $("proxyPort").value.trim(),
  };
}

function clearForm() {
  $("proxyType").value = "socks";
  $("proxyHost").value = "";
  $("proxyPort").value = "";
}

$("proxyAdd").onclick = async () => {
  const cfg = currentFormCfg();
  const res = await send({ cmd: "addProxy", cfg });
  if (res.error) {
    return setMsg($("proxyMsg"), res.error || "Could not add proxy", "bad");
  }
  state = res;
  clearForm();
  setMsg($("proxyMsg"), "Added.", "ok");
  render();
};

$("proxyToggle").onchange = async (e) => {
  const res = await send({ cmd: "setProxyOn", on: e.target.checked });
  state = res;
  // Probe only on explicit toggle, not on every render — a probe is a real
  // network request with a 10s timeout.
  if (state.proxyOn) {
    refreshActivePing();
    if (state.autoChange) runAutoChangeSearch();
  }
  else setActivePing("");
  if (res.error) setMsg($("proxyMsg"), res.error, "bad");
};

// One auto-switch attempt is bounded by AUTOCHANGE_TIMEOUT; a timed-out probe
// is treated as a failure so the search moves on instead of hanging forever.
const AUTOCHANGE_TIMEOUT = 30000;

function testWithTimeout(id, deadline) {
  const ms = Math.max(0, deadline - Date.now());
  if (ms <= 0) return Promise.resolve({ ok: false, error: "timeout" });
  return Promise.race([
    send({ cmd: "testProxy", id }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]).catch(() => ({ ok: false, error: "timeout" }));
}

// Checks the active proxy and switches to the first working one.
async function runAutoChangeSearch() {
  if (!state.autoChange) return;
  if (!state.proxyOn || !state.activeId) return setActivePing("");

  const deadline = Date.now() + (state.autoChangeTimeout || AUTOCHANGE_TIMEOUT);
  const tP = await testWithTimeout(state.activeId, deadline);
  if (tP.ok) return refreshActivePing();

  setActivePing("searching for a working proxy...");
  for (const chosen of state.proxies) {
    const r = await testWithTimeout(chosen.id, deadline);
    if (r.ok) {
      state = await send({ cmd: "selectProxy", id: chosen.id });
      render();
      // Bring the newly selected proxy into view.
      const rows = document.querySelectorAll("#list .proxy");
      for (const row of rows) {
        if (row.classList.contains("active")) row.scrollIntoView({ block: "nearest" });
      }
      if (state.proxyOn) refreshActivePing();
      break;
    }
  }
}

$("autoChangeToggle").onchange = async (e) => {
  const res = await send({ cmd: "setAutoChangeOn", on: e.target.checked });
  state = res;
  if (res.error) setMsg($("proxyMsg"), res.error, "bad");
  if (!state.autoChange) return;
  if (e.target.checked) runAutoChangeSearch();
};

$("autoChangeTimeout").onchange = async (e) => {
  const ms = Number(e.target.value);
  if (!Number.isFinite(ms) || ms <= 0) return;
  state = await send({ cmd: "setAutoChangeTimeout", ms });
};

$("pingTimeout").onchange = async (e) => {
  const ms = Number(e.target.value);
  if (!Number.isFinite(ms) || ms < 100) return;
  state = await send({ cmd: "setPingTimeout", ms });
};

// ---- bypass list ----
function renderBypass() {
  const list = $("bypassList");
  list.innerHTML = "";
  const hosts = state.bypass || [];
  if (!hosts.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No bypass hosts.";
    list.appendChild(empty);
    return;
  }
  for (const h of hosts) {
    const div = document.createElement("div");
    div.className = "proxy";
    const addr = document.createElement("span");
    addr.className = "addr";
    addr.textContent = h;
    addr.title = h;
    const delBtn = document.createElement("button");
    delBtn.textContent = "×";
    delBtn.onclick = async () => {
      const res = await send({ cmd: "removeBypass", host: h });
      state = res;
      renderBypass();
    };
    div.append(addr, delBtn);
    list.appendChild(div);
  }
}

$("bypassAdd").onclick = async () => {
  const host = $("bypassHost").value.trim();
  if (!host) return;
  const res = await send({ cmd: "addBypass", host });
  state = res;
  $("bypassHost").value = "";
  renderBypass();
};

function setActivePing(text, kind) {
  const el = $("activePing");
  el.textContent = text;
  el.className = "active-ping" + (kind ? " " + kind : "");
}

async function refreshActivePing() {
  if (!state.proxyOn || !state.activeId) return setActivePing("");
  setActivePing("...");
  const id = state.activeId;
  const rowEl = pingEls.get(id);
  const r = await send({ cmd: "testProxy", id });
  // The popup may have been toggled off or reselected while we waited.
  if (!state.proxyOn || state.activeId !== id) return;
  // Keep the row-level latency/status in sync with the fresh result — it may
  // have been showing a stale cached value from before an AutoChange switch.
  if (rowEl) showResult(rowEl, r);
  if (r.ok) setActivePing(r.ms + " ms", "ok");
  else setActivePing(shortErr(r.error), "bad");
}

$("freeProxy").onclick = () => chrome.tabs.create({ url: "freeproxy.html" });

// ---- list ----
function labelFor(p) {
  return (p.country ? p.country + " " : "") + p.host + ":" + p.port;
}

function showResult(el, r) {
  if (!el) return;
  if (r.ok) {
    el.textContent = r.ms + " ms";
    el.className = "ping ok";
  } else {
    el.textContent = shortErr(r.error);
    el.className = "ping bad";
  }
}

function render() {
  $("proxyToggle").checked = !!state.proxyOn;
  $("autoChangeToggle").checked = !!state.autoChange;
  const timeoutEl = $("autoChangeTimeout");
  if (timeoutEl) timeoutEl.value = String(state.autoChangeTimeout || 30000);
  const pingTimeoutEl = $("pingTimeout");
  if (pingTimeoutEl) pingTimeoutEl.value = String(state.pingTimeout || 10000);
  pingEls.clear();

  const list = $("list");
  list.innerHTML = "";

  if (!state.proxies.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No proxies added yet.";
    list.appendChild(empty);
    return;
  }

  for (const p of state.proxies) {
    const div = document.createElement("div");
    div.className = "proxy" + (p.id === state.activeId ? " active" : "");

    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "activeProxy";
    radio.checked = p.id === state.activeId;
    radio.onchange = async () => {
      const res = await send({ cmd: "selectProxy", id: p.id });
      state = res;
      render();
      if (state.proxyOn) {
        refreshActivePing();
        if (state.autoChange) runAutoChangeSearch();
      }
      if (res.error) setMsg($("proxyMsg"), res.error, "bad");
    };

    const type = document.createElement("span");
    type.className = "type";
    type.textContent = p.type === "socks" ? "socks5" : p.type;

    const ping = document.createElement("span");
    ping.className = "ping";
    pingEls.set(p.id, ping);
    // No cache: latency/status indicators are shown only from fresh probes,
    // so they can never go stale or show false values.
    ping.className = "ping";
    ping.textContent = "";

    const addr = document.createElement("span");
    addr.className = "addr";
    addr.textContent = labelFor(p);
    addr.title = labelFor(p);

    const testBtn = document.createElement("button");
    testBtn.textContent = "Test";
    testBtn.onclick = async () => {
      testBtn.disabled = true;
      ping.className = "ping";
      ping.textContent = "...";
      const r = await send({ cmd: "testProxy", id: p.id });
      testBtn.disabled = false;
      testBtn.textContent = "Test";
      showResult(ping, r);
    };

    const delBtn = document.createElement("button");
    delBtn.textContent = "×";
    delBtn.onclick = async () => {
      state = await send({ cmd: "removeProxy", id: p.id });
      render();
      if (state.proxyOn) refreshActivePing();
      else setActivePing("");
    };

    div.append(radio, type, addr, ping, testBtn, delBtn);
    list.appendChild(div);
  }
}

// ---- test all ----
// Probes are serialized by the background script (Chrome's proxy setting is
// global), so this fires them all and lets the queue work through them.
$("testAll").onclick = async () => {
  const btn = $("testAll");
  btn.disabled = true;
  btn.textContent = "...";
  try {
    await Promise.all(
      state.proxies.map(async (p) => {
        const el = pingEls.get(p.id);
        if (el) {
          el.className = "ping";
          el.textContent = "...";
        }
        showResult(el, await send({ cmd: "testProxy", id: p.id }));
      })
    );
  } finally {
    btn.disabled = false;
    btn.textContent = "Test all";
  }
};

// ---- delete all ----
$("delAll").onclick = async () => {
  if (!state.proxies.length) return;
  if (!confirm("Delete all saved proxies?")) return;
  state = await send({ cmd: "clearProxies" });
  render();
  setActivePing("");
};

// ---- init ----
send({ cmd: "getState" }).then((s) => {
  state = s;
  clearForm();
  render();
  renderBypass();
  if (s.proxyError) setMsg($("proxyMsg"), "Proxy error: " + shortErr(s.proxyError), "bad");
  if (state.proxyOn && state.activeId) refreshActivePing();
});