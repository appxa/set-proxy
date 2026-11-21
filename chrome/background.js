"use strict";

/*
 * Chrome MV3 port of set-proxy.
 *
 * Chrome has no per-request proxy API (Firefox's proxy.onRequest), and
 * chrome.proxy.settings is global/declarative. So to TEST a proxy we must
 * temporarily install it as the global proxy, fetch, then restore the real
 * state. That means a probe repoints the whole browser for its duration — the
 * free-proxy UI warns about this and every scan is cancellable.
 *
 * mode:"fixed_servers" (not a PAC script) — simpler, no eval, no caching
 * weirdness. Scheme mapping: socks→"socks5", http→"http", https→"https".
 * SOCKS5 does remote DNS by default (matches Firefox proxyDNS:true).
 */

let proxies = [];
let activeId = null;
let proxyOn = false;
let autoChange = false;
let autoChangeTimeout = 30000;
let pingTimeout = 10000;
// Hosts that must never go through a proxy.
let bypass = [];
// In-memory only: survives popup closes, gone when the service worker idles out.
let pingResults = {};

chrome.storage.local.get(["proxies", "activeId", "proxyOn", "autoChange", "autoChangeTimeout", "pingTimeout", "bypass"], (res) => {
  proxies = res.proxies || [];
  activeId = res.activeId || null;
  proxyOn = !!res.proxyOn;
  autoChange = !!res.autoChange;
  autoChangeTimeout = Number(res.autoChangeTimeout) || 30000;
  pingTimeout = Number(res.pingTimeout) || 10000;
  bypass = Array.isArray(res.bypass) ? res.bypass.map(String) : [];
  updateIcon();
  applyProxy();
});

function saveState() {
  return new Promise((resolve) => {
    chrome.storage.local.set({ proxies, activeId, proxyOn, autoChange, autoChangeTimeout, pingTimeout, bypass }, () => resolve());
  });
}

function updateIcon() {
  const state = (proxyOn || autoChange) && activeId ? "on" : "off";
  chrome.action.setIcon({
    path: {
      16: `icons/icon-${state}-16.png`,
      32: `icons/icon-${state}-32.png`,
      48: `icons/icon-${state}-48.png`,
      96: `icons/icon-${state}-96.png`,
      128: `icons/icon-${state}-128.png`,
    },
  });
}

function activeProxy() {
  return proxies.find((p) => p.id === activeId) || null;
}

function snapshot() {
  return { proxies, activeId, proxyOn, autoChange, autoChangeTimeout, pingTimeout, bypass, pingResults };
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

// ---- validation ----
// Every path that accepts proxy data from a message goes through this, so a
// bad host/port can never reach chrome.proxy.settings. Returns { cfg } or
// { error }.
function normalizeCfg(cfg) {
  if (!cfg || typeof cfg !== "object") return { error: "invalid proxy" };

  const type = cfg.type;
  if (type !== "socks" && type !== "http" && type !== "https") {
    return { error: "type must be socks, http or https" };
  }

  const host = String(cfg.host == null ? "" : cfg.host).trim();
  if (!host) return { error: "host required" };
  if (/[\s/\\]/.test(host)) return { error: "invalid host" };

  const port = Number(String(cfg.port == null ? "" : cfg.port).trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { error: "port must be 1-65535" };
  }

  return {
    cfg: {
      type,
      host,
      port,
      country: cfg.country ? String(cfg.country) : null,
    },
  };
}

function proxyScheme(type) {
  return type === "socks" ? "socks5" : type;
}

// ---- proxy settings ----
// Resolves { ok: true } or { error } — Chrome reports rejected settings via
// chrome.runtime.lastError, which is easy to miss, so we check it explicitly
// instead of assuming the write succeeded.
function setProxySettings(cfg, bypassList = bypass) {
  return new Promise((resolve) => {
    const done = () => {
      const err = chrome.runtime.lastError;
      resolve(err ? { error: err.message || "proxy setting failed" } : { ok: true });
    };

    if (!cfg || !cfg.host || !cfg.port) {
      chrome.proxy.settings.set({ value: { mode: "direct" }, scope: "regular" }, done);
      return;
    }

    chrome.proxy.settings.set(
      {
        value: {
          mode: "fixed_servers",
          bypassList,
          rules: {
            singleProxy: {
              scheme: proxyScheme(cfg.type),
              host: cfg.host,
              port: Number(cfg.port),
            },
          },
        },
        scope: "regular",
      },
      done
    );
  });
}

// Applies the user's real selection (active proxy, or direct when off). Skips
// the write when the setting already matches, so unrelated state changes
// don't churn the browser's proxy configuration.
let appliedKey = null;

function desiredKey() {
  const cfg = proxyOn ? activeProxy() : null;
  const base = !cfg || !cfg.host || !cfg.port ? "direct" : cfg.type + ":" + cfg.host + ":" + cfg.port;
  // Bypass list is part of the effective proxy config.
  return base + "|" + bypass.join(",");
}

async function applyProxy() {
  const key = desiredKey();
  if (key === appliedKey) return { ok: true };
  const res = await setProxySettings(key === "direct" ? null : activeProxy());
  if (res.ok) appliedKey = key;
  return res;
}

// Chrome reports proxy failures here; record them so the popup can show them
// rather than looking like the extension is silently not working.
let lastProxyError = null;

chrome.proxy.onProxyError.addListener((details) => {
  lastProxyError = (details && details.error) || "proxy error";
  console.error("Proxy error:", lastProxyError, details && details.details);
  maybeAutoSwitch();
});

// AutoChange: when the active proxy errors out, switch to another working one.
async function maybeAutoSwitch() {
  if (!autoChange || !proxyOn) return;
  const active = activeProxy();
  if (!active) return;

  const result = await runTest(active);
  pingResults[active.id] = result;
  if (result.ok) return;

  for (const chosen of proxies) {
    if (chosen.id === active.id) continue;
    const r = await runTest(chosen);
    if (r.ok) {
      pingResults[chosen.id] = r;
      activeId = chosen.id;
      await saveState();
      updateIcon();
      await applyProxy();
      return;
    }
  }
}

// ---- messages from popup ----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMsg(msg)
    .then(sendResponse)
    .catch((e) => sendResponse({ ...snapshot(), ok: false, error: e.message || "error" }));
  return true;
});

async function handleMsg(msg) {
  switch (msg.cmd) {
    case "getState":
      return { ...snapshot(), proxyError: lastProxyError };

    case "addProxy": {
      const norm = normalizeCfg(msg.cfg);
      if (norm.error) return { ...snapshot(), ok: false, error: norm.error };
      const id = newId();
      proxies.push({ id, ...norm.cfg });
      if (!activeId) activeId = id;
      await saveState();
      updateIcon();
      const applied = await applyProxy();
      return { ...snapshot(), saved: true, ...applied };
    }

    case "removeProxy": {
      proxies = proxies.filter((p) => p.id !== msg.id);
      delete pingResults[msg.id];
      if (activeId === msg.id) {
        activeId = proxies.length ? proxies[0].id : null;
      }
      await saveState();
      updateIcon();
      await applyProxy();
      return snapshot();
    }

    case "clearProxies": {
      proxies = [];
      activeId = null;
      pingResults = {};
      await saveState();
      updateIcon();
      await applyProxy();
      return snapshot();
    }

    case "selectProxy":
      activeId = msg.id;
      // Drop the cached ping for the newly selected proxy — a previous value
      // here can be stale (e.g. it was cached before the proxy went bad).
      delete pingResults[msg.id];
      await saveState();
      updateIcon();
      await applyProxy();
      // AutoChange: if proxies are on and AutoChange is enabled, make sure we
      // end up on a working proxy (probe + switch).
      if (proxyOn && autoChange) await maybeAutoSwitch();
      return { ...snapshot(), ...(await applyProxy()) };

    case "setProxyOn":
      proxyOn = !!msg.on;
      await saveState();
      updateIcon();
      if (proxyOn && autoChange) await maybeAutoSwitch();
      return { ...snapshot(), ...(await applyProxy()) };

    case "setAutoChangeOn":
      autoChange = !!msg.on;
      await saveState();
      updateIcon();
      if (autoChange && proxyOn) await maybeAutoSwitch();
      return snapshot();

    case "setAutoChangeTimeout":
      autoChangeTimeout = Number(msg.ms) > 0 ? Number(msg.ms) : 30000;
      await saveState();
      updateIcon();
      return snapshot();

    case "setPingTimeout":
      pingTimeout = Number(msg.ms) > 0 ? Number(msg.ms) : 10000;
      await saveState();
      updateIcon();
      return snapshot();

    case "addBypass": {
      const host = String(msg.host || "").trim().toLowerCase();
      if (host && !bypass.includes(host)) bypass.push(host);
      await saveState();
      updateIcon();
      await applyProxy();
      return snapshot();
    }

    case "removeBypass": {
      bypass = bypass.filter((h) => h !== msg.host);
      await saveState();
      updateIcon();
      await applyProxy();
      return snapshot();
    }

    case "clearBypasses":
      bypass = [];
      await saveState();
      updateIcon();
      return snapshot();

    case "testProxy": {
      const cfg = proxies.find((p) => p.id === msg.id);
      if (!cfg) return { ok: false, error: "not found" };
      const result = await runTest(cfg);
      pingResults[msg.id] = result;
      return result;
    }

    case "testProxyCfg": {
      const norm = normalizeCfg(msg.cfg);
      if (norm.error) return { ok: false, error: norm.error };
      return runTest(norm.cfg);
    }

    case "startScan":
      scanCancelled = false;
      return { ok: true };

    case "cancelScan":
      // Queued probes check this before installing, so a cancel takes effect
      // within one probe rather than after the whole scan.
      scanCancelled = true;
      return { ok: true };

    case "addProxies": {
      const existing = new Set(
        proxies.map((p) => p.type + ":" + p.host + ":" + p.port)
      );
      for (const raw of msg.cfgs || []) {
        const norm = normalizeCfg(raw);
        if (norm.error) continue;
        const cfg = norm.cfg;
        const key = cfg.type + ":" + cfg.host + ":" + cfg.port;
        if (existing.has(key)) continue;
        existing.add(key);
        const id = newId();
        proxies.push({ id, ...cfg });
        // Seed the cached ping so the popup shows it without re-probing.
        if (raw.ping && raw.ping.ok) pingResults[id] = { ok: true, ms: raw.ping.ms };
      }
      if (!activeId && proxies.length) activeId = proxies[0].id;
      await saveState();
      updateIcon();
      await applyProxy();
      return snapshot();
    }
  }
}

// ---- test runner ----
// chrome.proxy.settings is global, so probes must run one at a time: install
// the probe's proxy, fetch, then restore the user's real setting. Tests queue
// so a scan is strictly serial. Unlike a plain chain, the queue restores the
// real setting itself, and a cancel flag makes queued probes bail out
// immediately instead of running to completion.
let testChain = Promise.resolve();
let scanCancelled = false;

const PROBE_URL = "https://www.gstatic.com/generate_204";

function runTest(cfg) {
  const result = testChain.then(() => runTestInner(cfg));
  testChain = result.then(
    () => applyProxy(),
    () => applyProxy()
  );
  return result;
}

async function runTestInner(cfg) {
  if (scanCancelled) return { ok: false, error: "cancelled" };
  if (!cfg.host || !cfg.port) return { ok: false, error: "host/port required" };

  const install = await setProxySettings(cfg, []); // probes must not be bypassed (false positives)
  if (!install.ok) return { ok: false, error: install.error };
  if (scanCancelled) return { ok: false, error: "cancelled" };

  const start = performance.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), pingTimeout);
  try {
    const resp = await fetch(PROBE_URL, {
      cache: "no-store",
      credentials: "omit",
      signal: ctrl.signal,
    });
    const ms = Math.round(performance.now() - start);
    return resp.ok || resp.status === 204
      ? { ok: true, ms }
      : { ok: false, error: "HTTP " + resp.status };
  } catch (e) {
    return {
      ok: false,
      error: e.name === "AbortError" ? "timeout" : e.message || "unreachable",
    };
  } finally {
    clearTimeout(timer);
  }
}