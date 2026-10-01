"use strict";

/*
 * State
 * -----
 * proxies:  [{ id, type: 'socks'|'http'|'https', host, port, country }]
 * activeId: string|null   -- which proxy in the list is selected
 * proxyOn:  bool          -- global switch; when true, route traffic
 *                            through the selected (activeId) proxy
 */

let proxies = [];
let activeId = null;
let proxyOn = false;
// In-memory only: survives popup closes, disappears with Firefox/background shutdown.
let pingResults = {};

browser.storage.local
  .get(["proxies", "activeId", "proxyOn"])
  .then((res) => {
    proxies = res.proxies || [];
    activeId = res.activeId || null;
    proxyOn = !!res.proxyOn;
    updateIcon();
  });

function saveState() {
  return browser.storage.local.set({ proxies, activeId, proxyOn });
}

function updateIcon() {
  const state = proxyOn && activeId ? "on" : "off";
  browser.browserAction.setIcon({
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
  return { proxies, activeId, proxyOn, pingResults };
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

// ---- validation ----
// Every path that accepts proxy data from a message goes through this, so a
// bad host/port can never reach browser.proxy. Returns { cfg } or { error }.
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

// ---- proxy info builder ----
function toProxyInfo(cfg) {
  const info = { type: cfg.type, host: cfg.host, port: Number(cfg.port) };
  if (cfg.type === "socks") info.proxyDNS = true;
  return info;
}

// ---- proxy routing ----
// Single listener: ad-hoc __proxytest requests take priority, then the
// active proxy, then direct.
const pendingTests = new Map();

browser.proxy.onRequest.addListener(
  (requestInfo) => {
    // Only parse the URL while tests are pending — this listener fires on
    // every browser request, so a new URL() per call is wasteful.
    if (pendingTests.size) {
      try {
        const testId = new URL(requestInfo.url).searchParams.get("__proxytest");
        if (testId && pendingTests.has(testId)) {
          return toProxyInfo(pendingTests.get(testId));
        }
      } catch (e) {
        /* not a parseable URL, fall through to normal routing */
      }
    }

    if (!proxyOn) return { type: "direct" };

    const cfg = activeProxy();
    if (!cfg) return { type: "direct" };
    return toProxyInfo(cfg);
  },
  { urls: ["<all_urls>"] }
);

browser.proxy.onError.addListener((err) => {
  console.error("Proxy error:", err && err.message);
});

// ---- probe ----
// Reachability check for one {type,host,port}, routed through the __proxytest
// hook so it measures that specific proxy regardless of the global switch.
// Shared by testProxy (a saved proxy) and testProxyCfg (an ad-hoc candidate).
const PROBE_URL = "https://www.gstatic.com/generate_204";
const PROBE_TIMEOUT = 10000;

async function probeProxy(cfg) {
  const testId = newId();
  pendingTests.set(testId, cfg);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT);
  const start = performance.now();
  try {
    const resp = await fetch(PROBE_URL + "?__proxytest=" + testId, {
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
    pendingTests.delete(testId);
  }
}

// ---- messages from popup ----
browser.runtime.onMessage.addListener(async (msg) => {
  switch (msg.cmd) {
    case "getState":
      return snapshot();

    case "addProxy": {
      const norm = normalizeCfg(msg.cfg);
      if (norm.error) return { ...snapshot(), ok: false, error: norm.error };
      const id = newId();
      proxies.push({ id, ...norm.cfg });
      if (!activeId) activeId = id; // first one added becomes selected
      await saveState();
      updateIcon();
      return { ...snapshot(), ok: true };
    }

    case "removeProxy": {
      proxies = proxies.filter((p) => p.id !== msg.id);
      delete pingResults[msg.id];
      if (activeId === msg.id) {
        activeId = proxies.length ? proxies[0].id : null;
      }
      await saveState();
      updateIcon();
      return snapshot();
    }

    case "clearProxies": {
      proxies = [];
      activeId = null;
      pingResults = {};
      await saveState();
      updateIcon();
      return snapshot();
    }

    case "selectProxy":
      activeId = msg.id;
      await saveState();
      updateIcon();
      return snapshot();

    case "setProxyOn":
      proxyOn = !!msg.on;
      await saveState();
      updateIcon();
      return snapshot();

    case "testProxy": {
      const cfg = proxies.find((p) => p.id === msg.id);
      if (!cfg) return { ok: false, error: "not found" };
      const result = await probeProxy(cfg);
      pingResults[msg.id] = result;
      return result;
    }

    case "testProxyCfg": {
      // test a raw {type,host,port} without adding it to the list
      const norm = normalizeCfg(msg.cfg);
      if (norm.error) return { ok: false, error: norm.error };
      return probeProxy(norm.cfg);
    }

    case "addProxies": {
      // batch-add with dedup against the existing list
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
      return snapshot();
    }
  }
});