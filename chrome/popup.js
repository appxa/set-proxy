"use strict";

const $ = (id) => document.getElementById(id);
let state = { proxies: [], activeId: null, proxyOn: false, pingResults: {} };
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
  if (state.proxyOn) refreshActivePing();
  else setActivePing("");
  if (res.error) setMsg($("proxyMsg"), res.error, "bad");
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
  const r = await send({ cmd: "testProxy", id });
  // The popup may have been toggled off or reselected while we waited.
  if (!state.proxyOn || state.activeId !== id) return;
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
      if (state.proxyOn) refreshActivePing();
      if (res.error) setMsg($("proxyMsg"), res.error, "bad");
    };

    const type = document.createElement("span");
    type.className = "type";
    type.textContent = p.type === "socks" ? "socks5" : p.type;

    const ping = document.createElement("span");
    ping.className = "ping";
    pingEls.set(p.id, ping);
    // Cached from a previous probe or from the free-proxy scan; re-probing
    // only happens on an explicit Test.
    const cached = state.pingResults && state.pingResults[p.id];
    if (cached) showResult(ping, cached);

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
  if (s.proxyError) setMsg($("proxyMsg"), "Proxy error: " + shortErr(s.proxyError), "bad");
  if (state.proxyOn && state.activeId) refreshActivePing();
});