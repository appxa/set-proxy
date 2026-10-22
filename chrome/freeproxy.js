"use strict";

/*
 * Chrome build of the free-proxy scanner.
 *
 * Unlike Firefox (which routes each probe via a per-request __proxytest hook),
 * Chrome must install each probe's proxy as the global browser setting. A scan
 * therefore interrupts normal browsing, so the UI warns before starting and
 * every scan is cancellable.
 */

/*
 * Sources:
 *  - proxifly meta/data.json  -> small file with per-country proxy counts
 *  - proxifly countries/<CC>/data.txt -> one "proto://ip:port" per line
 *  - iplocate countries/<CC>/proxies.txt -> same format, second source
 *
 * The old "proxies/all/data.json" is ~21 MB and is rejected by jsDelivr
 * ("File size exceeded the configured limit of 20 MB"), which made the
 * response body non-JSON. We therefore only pull the small meta file plus
 * the single country file that the user actually clicks.
 */
const PROXIFLY_META = [
  "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/meta/data.json",
  "https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/meta/data.json",
];
const PROXIFLY_COUNTRY = [
  "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/countries/",
  "https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/countries/",
];
const IPLOCATE_BASE = [
  "https://raw.githubusercontent.com/iplocate/free-proxy-list/main/countries/",
  "https://cdn.jsdelivr.net/gh/iplocate/free-proxy-list@main/countries/",
];

let countryMap = {};
let scanStopped = false;

function $(id) { return document.getElementById(id); }
function send(msg) { return chrome.runtime.sendMessage(msg); }

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/* map source protocol → extension type (socks4 unsupported) */
function mapType(proto) {
  proto = (proto || "").toLowerCase();
  if (proto === "socks5") return "socks";
  if (proto === "http" || proto === "https") return proto;
  return null;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* iplocate txt: "socks5://1.2.3.4:1080" → { type, host, port } */
function parseIpLocate(text) {
  const out = [];
  for (const line of text.trim().split("\n")) {
    const m = line.trim().match(/^(socks5|socks4|https?):\/\/(.+):(\d+)$/i);
    if (!m) continue;
    const type = mapType(m[1]);
    if (!type) continue;
    out.push({ type, host: m[2], port: m[3] });
  }
  return out;
}

/* ---- fetch helpers ---- */
/* try each url in order, return the first non-empty body */
async function fetchText(urls) {
  let lastErr = new Error("no source");
  for (const url of urls) {
    try {
      const resp = await fetch(url, { cache: "no-store" });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const text = await resp.text();
      if (!text.trim()) throw new Error("empty response");
      return text;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

/* ---- load & render country list ---- */
async function loadCountries() {
  try {
    const text = await fetchText(PROXIFLY_META);
    let meta;
    try {
      meta = JSON.parse(text);
    } catch (e) {
      throw new Error("source did not return JSON");
    }
    const totals = (meta && meta.totals && meta.totals.countries) || null;
    if (!totals) throw new Error("unexpected response");

    countryMap = {};
    for (const cc of Object.keys(totals)) {
      const n = totals[cc] || 0;
      if (!n) continue;
      countryMap[cc.toUpperCase()] = { count: n };
    }
    renderCountries();
  } catch (e) {
    const d = el("div", "loading error", "Failed to load: " + (e.message || "error"));
    document.body.insertBefore(d, document.body.firstChild);
  }
}

function renderCountries() {
  const countries = Object.keys(countryMap).sort();
  const grid = $("countryGrid");
  grid.innerHTML = "";
  if (!countries.length) {
    grid.appendChild(el("div", "loading error", "No countries available."));
  }
  for (const cc of countries) {
    const btn = document.createElement("div");
    btn.className = "country";
    const flagImg = el("img", "flag");
    flagImg.src = `https://flagcdn.com/h20/${cc.toLowerCase()}.png`;
    flagImg.alt = cc;
    btn.append(
      flagImg,
      el("span", "cc", cc),
      el("span", "count", String(countryMap[cc].count))
    );
    btn.onclick = () => selectCountry(cc);
    grid.appendChild(btn);
  }

  const custom = document.createElement("div");
  custom.className = "country";
  custom.append(el("span", "flag", "✎"), el("span", "cc", "Custom"));
  custom.onclick = () => {
    $("countriesView").style.display = "none";
    $("customView").style.display = "";
    $("customInput").focus();
  };
  grid.appendChild(custom);
}

/* ---- select country → fetch + test + add ---- */
async function selectCountry(cc) {
  /* 1. proxifly proxies for this country */
  let proxiflyProxies = [];
  try {
    const text = await fetchText(PROXIFLY_COUNTRY.map((b) => b + cc + "/data.txt"));
    proxiflyProxies = parseIpLocate(text);
  } catch (e) { /* network error — try the second source anyway */ }

  /* 2. iplocate proxies for this country */
  let iplocateProxies = [];
  try {
    const text = await fetchText(IPLOCATE_BASE.map((b) => b + cc + "/proxies.txt"));
    iplocateProxies = parseIpLocate(text);
  } catch (e) { /* 404 or network — ignore */ }

  /* 3. combine + deduplicate */
  const seen = new Set();
  const unique = [...proxiflyProxies, ...iplocateProxies].filter((p) => {
    const key = p.type + ":" + p.host + ":" + p.port;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  showTestView(cc);
  if (!unique.length) {
    const s = $("summary");
    s.textContent = "";
    s.appendChild(el("div", "error", "No proxies found for " + cc + "."));
    return;
  }
  /* Chrome switches the whole browser to each proxy in turn, so a huge list
     would take forever. Cap the scan and say so in the summary. */
  const MAX_PROXIES = 300;
  const picked = unique.slice(0, MAX_PROXIES);
  $("countryTitle").textContent = cc + " (" + picked.length + " of " + unique.length + ")";
  await runTests(shuffle(picked), cc + " (" + picked.length + " of " + unique.length + ")", cc);
}

/* ---- shared test+add pipeline (country + custom) ---- */
async function runTests(picked, label, country) {
  // Chrome probes are serialized in the background worker, so a small window
  // here just keeps the UI from queueing hundreds of messages at once.
  const CONCURRENCY = 5;

  scanStopped = false;
  await send({ cmd: "startScan" });
  $("stopBtn").style.display = "";
  $("stopBtn").textContent = "Stop scan";
  $("testList").innerHTML = "";
  $("summary").innerHTML = "";
  $("progressFill").style.width = "0";

  /* create test rows */
  const list = $("testList");
  const rows = [];
  for (const p of picked) {
    const row = document.createElement("div");
    row.className = "test-row";
    row.append(
      el("span", "icon", "⏳"),
      el("span", "type", p.type),
      el("span", "addr", p.host + ":" + p.port),
      el("span", "result testing", "...")
    );
    list.appendChild(row);
    rows.push(row);
  }

  let done = 0;
  const working = [];

  for (let i = 0; i < picked.length; i += CONCURRENCY) {
    if (scanStopped) break;
    const batch = picked.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (p, batchIdx) => {
        const row = rows[i + batchIdx];
        const r = await send({ cmd: "testProxyCfg", cfg: p });
        done++;
        $("progressFill").style.width = (done / picked.length * 100) + "%";

        const icon = row.querySelector(".icon");
        const result = row.querySelector(".result");
        if (r.ok) {
          working.push({ ...p, ping: { ok: true, ms: r.ms } });
          icon.textContent = "✅";
          result.textContent = r.ms + " ms";
          result.className = "result ok";
        } else if (r.error === "cancelled") {
          // Drop the row entirely — a cancelled probe tells us nothing.
          row.remove();
        } else {
          icon.textContent = "❌";
          result.textContent = r.error || "failed";
          result.className = "result bad";
        }
      })
    );
  }

  /* add working proxies to the list */
  if (working.length) {
    await send({
      cmd: "addProxies",
      cfgs: working.map((p) => ({ ...p, country: country || null })),
    });
  }

  /* summary */
  const s = $("summary");
  s.textContent = "";
  const tested = done;
  if (scanStopped) {
    s.appendChild(el("div", "big", "Scan stopped."));
    s.appendChild(el("div", "sub", "Added " + working.length + " of " + tested + " tested to your list."));
  } else if (working.length) {
    s.appendChild(el("div", "big ok-text",
      "Added " + working.length + " working prox" + (working.length === 1 ? "y" : "ies") + " to your list."));
    s.appendChild(el("div", "sub", "Tested " + tested + " from " + label));
  } else {
    s.appendChild(el("div", "big error", "No working proxies found."));
    s.appendChild(el("div", "sub", "Tested " + tested + " from " + label));
  }
  $("stopBtn").style.display = "none";
}

$("stopBtn").onclick = async () => {
  scanStopped = true;
  $("stopBtn").textContent = "Stopping...";
  await send({ cmd: "cancelScan" });
};

function showTestView(title) {
  $("countriesView").style.display = "none";
  $("customView").style.display = "none";
  $("testView").style.display = "";
  $("countryTitle").textContent = title;
}

/* ---- back button ---- */
$("backBtn").onclick = () => {
  $("testView").style.display = "none";
  $("countriesView").style.display = "";
};

$("customBack").onclick = () => {
  $("customView").style.display = "none";
  $("countriesView").style.display = "";
};

/* parse custom input: accepts "ip:port", "proto://ip:port" */
function parseCustom(text, fallbackType) {
  const out = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let type = fallbackType, host, port;
    const m = t.match(/^(socks5|socks4|https?):\/\/(.+):(\d+)$/i);
    if (m) {
      type = mapType(m[1]) || fallbackType;
      host = m[2]; port = m[3];
    } else {
      const m2 = t.match(/^(.+):(\d+)$/);
      if (!m2) continue;
      host = m2[1]; port = m2[2];
    }
    out.push({ type, host, port });
  }
  return out;
}

$("customScan").onclick = async () => {
  const text = $("customInput").value;
  const fallbackType = $("customType").value;
  const msg = $("customMsg");
  const proxies = parseCustom(text, fallbackType);
  if (!proxies.length) {
    msg.textContent = "No valid proxies found. Use ip:port or proto://ip:port";
    msg.className = "msg error";
    return;
  }
  msg.textContent = "";
  showTestView("Custom list (" + proxies.length + ")");
  // country stays null so custom entries are not tagged with a country code
  await runTests(proxies, "your custom list", null);
};

/* ---- init ---- */
loadCountries();