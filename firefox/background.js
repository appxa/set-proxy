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
let autoChange = false;
let autoChangeTimeout = 30000;
let pingTimeout = 10000;
// Hosts that must never go through a proxy.
let bypass = [];
// In-memory only: survives popup closes, disappears with Firefox/background shutdown.
let pingResults = {};
// AutoChange watchdog: periodically probes the active proxy while AutoChange
// is on and the proxy is on (proxy.onError alone is not reliable for real proxy
// failures in Firefox, so we drive the check from state changes + a timer).
let autoSwitchTimer = null;
const AUTOSWITCH_INTERVAL_MS = 10000;

browser.storage.local.get(["proxies", "activeId", "proxyOn", "autoChange", "autoChangeTimeout", "pingTimeout", "bypass"])
  .then((res) => {
    proxies = res.proxies || [];
    activeId = res.activeId || null;
    proxyOn = !!res.proxyOn;
    autoChange = !!res.autoChange;
    autoChangeTimeout = Number(res.autoChangeTimeout) || 30000;
    pingTimeout = Number(res.pingTimeout) || 10000;
    bypass = Array.isArray(res.bypass) ? res.bypass.map(String) : [];
    updateIcon();
    scheduleAutoSwitch();
  });

function saveState()
{
  return browser.storage.local.set({proxies, activeId, proxyOn, autoChange, autoChangeTimeout, pingTimeout, bypass});
}

function updateIcon()
{
  const state = (proxyOn || autoChange) && activeId ? "on" : "off";
  browser.browserAction.setIcon({
    path:
    {
      16: `icons/icon-${state}-16.png`,
      32: `icons/icon-${state}-32.png`,
      48: `icons/icon-${state}-48.png`,
      96: `icons/icon-${state}-96.png`,
      128: `icons/icon-${state}-128.png`,
    },
  });
}

function activeProxy()
{
  return proxies.find((p) => p.id === activeId) || null;
}

// Hosts from the bypass list never go through a proxy (exact or subdomain).
function isBypassed(hostname)
{
  const host = String(hostname || "").toLowerCase();
  if (!host) return false;
  return bypass.some((b) => host === b || host.endsWith("." + b));
}

function snapshot()
{
  return {proxies, activeId, proxyOn, autoChange, autoChangeTimeout, pingTimeout, bypass, pingResults};
}

function newId()
{
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

// ---- validation ----
// Every path that accepts proxy data from a message goes through this, so a
// bad host/port can never reach browser.proxy. Returns { cfg } or { error }.
function normalizeCfg(cfg)
{
  const type = cfg.type;
  const host = String(cfg.host == null ? "" : cfg.host).trim();
  const port = Number(String(cfg.port == null ? "" : cfg.port).trim());

  if (!cfg || typeof cfg !== "object")
    return { error: "invalid proxy" };

  if (type !== "socks" && type !== "http" && type !== "https")
    return { error: "non socks4|socks5|http|https type"};

  if (!host)
    return { error: "host required" };
  if (/[\s/\\]/.test(host))
    return {error: "invalid host"};

  if (!Number.isInteger(port) || port < 1 || port > 65535)
    return {error: "port must be 1-65535"};

  return {cfg: {type, host, port, country: cfg.country ? String(cfg.country) : null, },
  };
}

// ---- proxy info builder ----
function toProxyInfo(cfg)
{
  const info = {type: cfg.type, host: cfg.host, port: Number(cfg.port)};
  if (cfg.type === "socks")
    info.proxyDNS = true;

  return info;
}

// ---- proxy routing ----
// Single listener: ad-hoc __proxytest requests take priority, then the
// active proxy, then direct.
const pendingTests = new Map();

browser.proxy.onRequest.addListener(
  (requestInfo) => {
    // Ad-hoc __proxytest requests take priority and are never subject to the
    // bypass list — bypassing here would turn a probe into a direct connection
    // and produce a false positive.
    // Only parse the URL while tests are pending — this listener fires on
    // every browser request, so a new URL() per call is wasteful.
    if (pendingTests.size)
    {
      try
      {
        const testId = new URL(requestInfo.url).searchParams.get("__proxytest");
        if (testId && pendingTests.has(testId))
          return toProxyInfo(pendingTests.get(testId));
      }
      catch (e)
      {}
    }

    // Bypass list wins: these hosts never go through a proxy.
    let hostname = null;
    try { hostname = new URL(requestInfo.url).hostname; } catch (e) {}
    if (hostname && isBypassed(hostname)) return {type: "direct"};

    if (!proxyOn)
      return {type: "direct"};

    const cfg = activeProxy();
    if (!cfg)
      return {type: "direct"};

    return toProxyInfo(cfg);
  },
  { urls: ["<all_urls>"] }
);

browser.proxy.onError.addListener((err) => {
  console.error("Proxy error:", err && err.message);
  maybeAutoSwitch();
});

// (Re)start the AutoChange watchdog while it is armed.
function scheduleAutoSwitch()
{
  if (autoSwitchTimer) clearInterval(autoSwitchTimer);
  autoSwitchTimer = null;
  if (autoChange && proxyOn)
    autoSwitchTimer = setInterval(() => maybeAutoSwitch(), AUTOSWITCH_INTERVAL_MS);
}

// AutoChange: when the active proxy fails, switch to another working one.
async function maybeAutoSwitch()
{
  if (!autoChange || !proxyOn) return;
  const active = activeProxy();
  if (!active) return;

  const result = await probeProxy(active);
  pingResults[active.id] = result;
  if (result.ok) return;

  for (const chosen of proxies)
  {
    if (chosen.id === active.id) continue;
    const r = await probeProxy(chosen);
    if (r.ok)
    {
      pingResults[chosen.id] = r;
      activeId = chosen.id;
      await saveState();
      updateIcon();
      return;
    }
  }
}

// ---- probe ----
// Reachability check for one {type,host,port}, routed through the __proxytest
// hook so it measures that specific proxy regardless of the global switch.
// Shared by testProxy (a saved proxy) and testProxyCfg (an ad-hoc candidate).
const PROBE_URL = "https://www.gstatic.com/generate_204";

async function probeProxy(cfg)
{
  const testId = newId();
  pendingTests.set(testId, cfg);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), pingTimeout);
  const start = performance.now();

  try
  {
    const resp = await fetch(PROBE_URL + "?__proxytest=" + testId, {cache: "no-store", credentials: "omit", signal: ctrl.signal,});
    const ms = Math.round(performance.now() - start);
    return resp.ok || resp.status === 204 ? {ok: true, ms} : {ok: false, error: "HTTP " + resp.status};
  }
  catch (e)
  {
    return {ok: false, error: e.name === "AbortError" ? "timeout" : e.message || "unreachable",};
  }
  finally
  {
    clearTimeout(timer);
    pendingTests.delete(testId);
  }
}

// ---- messages from popup ----
browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMsg(msg)
    .then(sendResponse)
    .catch((e) => sendResponse({ ...snapshot(), ok: false, error: e.message || "error" }));
  return true;
});

async function handleMsg(msg) {
  switch (msg.cmd)
  {
    case "getState":
      return snapshot();

    case "addProxy":
    {
      const norm = normalizeCfg(msg.cfg);
      const id = newId();

      if (norm.error)
        return {...snapshot(), ok: false, error: norm.error};

      proxies.push({ id, ...norm.cfg});
      
      if (!activeId)
        activeId = id; // first one added becomes selected

      await saveState();
      updateIcon();
      return {...snapshot(), ok: true };
    }

    case "removeProxy":
    {
      proxies = proxies.filter((p) => p.id !== msg.id);
      delete pingResults[msg.id];
      
      if (activeId === msg.id)
        activeId = proxies.length ? proxies[0].id : null;

      await saveState();
      updateIcon();
      return snapshot();
    }

    case "clearProxies":
    {
      proxies = [];
      activeId = null;
      pingResults = {};
      await saveState();
      updateIcon();
      return snapshot();
    }

    case "selectProxy":
      activeId = msg.id;
      // Drop the cached ping for the newly selected proxy — a previous value
      // here can be stale (e.g. it was cached before the proxy went bad).
      delete pingResults[msg.id];
      await saveState();
      updateIcon();
      // AutoChange: if proxies are on and AutoChange is enabled, make sure we
      // end up on a working proxy (probe + switch). Firefox's proxy.onError is
      // unreliable for real proxy failures, so drive it from state changes too.
      if (proxyOn && autoChange) await maybeAutoSwitch();
      scheduleAutoSwitch();
      return snapshot();

    case "setProxyOn":
      proxyOn = !!msg.on;
      await saveState();
      updateIcon();
      if (proxyOn && autoChange) await maybeAutoSwitch();
      scheduleAutoSwitch();
      return snapshot();

    case "setAutoChangeOn":
      autoChange = !!msg.on;
      await saveState();
      updateIcon();
      if (autoChange && proxyOn) await maybeAutoSwitch();
      scheduleAutoSwitch();
      return snapshot();

    case "setAutoChangeTimeout":
    {
      const ms = Number(msg.ms);
      autoChangeTimeout = Number.isFinite(ms) && ms > 0 ? ms : 30000;
      await saveState();
      updateIcon();
      return snapshot();
    }

    case "setPingTimeout":
    {
      const ms = Number(msg.ms);
      pingTimeout = Number.isFinite(ms) && ms > 0 ? ms : 10000;
      await saveState();
      updateIcon();
      return snapshot();
    }

    case "addBypass":
    {
      const host = String(msg.host || "").trim().toLowerCase();
      if (host && !bypass.includes(host)) bypass.push(host);
      await saveState();
      updateIcon();
      return snapshot();
    }

    case "removeBypass":
    {
      bypass = bypass.filter((h) => h !== msg.host);
      await saveState();
      updateIcon();
      return snapshot();
    }

    case "clearBypasses":
    {
      bypass = [];
      await saveState();
      updateIcon();
      return snapshot();
    }

    case "testProxy":
    {
      const cfg = proxies.find((p) => p.id === msg.id);

      if (!cfg)
        return {ok: false, error: "not found"};
      
      const result = await probeProxy(cfg);
      pingResults[msg.id] = result;
      return result;
    }

    case "testProxyCfg":
    {
      // test a raw {type,host,port} without adding it to the list
      const norm = normalizeCfg(msg.cfg);

      if (norm.error)
        return {ok: false, error: norm.error};
      
      return probeProxy(norm.cfg);
    }

    case "addProxies":
    {
      // batch-add with dedup against the existing list
      const existing = new Set(proxies.map((p) => p.type + ":" + p.host + ":" + p.port));
      for (const raw of msg.cfgs || [])
      {
        const norm = normalizeCfg(raw);
        const cfg = norm.cfg;
        const key = cfg.type + ":" + cfg.host + ":" + cfg.port;
        
        if (norm.error || existing.has(key))
          continue;

        existing.add(key);
        const id = newId();
        proxies.push({ id, ...cfg });

        // Seed the cached ping so the popup shows it without re-probing.
        if (raw.ping && raw.ping.ok)
            pingResults[id] = {ok: true, ms: raw.ping.ms};
      }

      if (!activeId && proxies.length)
          activeId = proxies[0].id;

      await saveState();
      updateIcon();
      return snapshot();
    }
  }
}
