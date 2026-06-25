// TEMPO Slider - popup script

const ext = (typeof browser !== 'undefined') ? browser : chrome;
const BUILTIN = ['bandcamp.com', 'beatport.com', 'traxsource.com', 'discogs.com'];

// built-in サイトの動作に必要な追加 host_permissions（音源 CDN や埋め込み元）。
// Firefox MV3 ではアップデート時に新規追加された host_permissions は自動付与されず
// ユーザーの明示的な許可が必要になるため、popup から検出 → 承認誘導する。
const BUILTIN_DEPS = {
  'bandcamp.com':  ['bandcamp.com', 'bcbits.com'],
  'beatport.com':  ['beatport.com', 'akamaized.net'],
  'traxsource.com':['traxsource.com'],
  'discogs.com':   ['discogs.com', 'youtube.com', 'youtube-nocookie.com'],
};

function originPatternsFor(hostname) {
  return [`https://*.${hostname}/*`, `https://${hostname}/*`];
}

async function missingDeps(builtinHost) {
  const deps = BUILTIN_DEPS[builtinHost] || [builtinHost];
  const missing = [];
  for (const dep of deps) {
    try {
      const granted = await ext.permissions.contains({ origins: originPatternsFor(dep) });
      if (!granted) missing.push(dep);
    } catch {
      missing.push(dep);
    }
  }
  return missing;
}

const $ = (sel) => document.querySelector(sel);

let currentTabInfo = null;

async function getCurrentTab() {
  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function extractHostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch { return null; }
}

function reduceToRoot(hostname) {
  // example.subdomain.com → example.com (最大2階層)
  if (!hostname) return hostname;
  const parts = hostname.split('.');
  if (parts.length >= 2) return parts.slice(-2).join('.');
  return hostname;
}

function isBuiltin(host) {
  if (!host) return false;
  return BUILTIN.some(b => host === b || host.endsWith('.' + b));
}

function setStatus(msg, isError) {
  const el = $('#status');
  el.textContent = msg || '';
  el.classList.toggle('is-error', !!isError);
}

async function bg(payload) {
  return ext.runtime.sendMessage({ target: 'tempo-slider-bg', ...payload });
}

async function refresh() {
  await refreshCurrentSiteButton();
  await renderList();
}

async function refreshCurrentSiteButton() {
  const tab = await getCurrentTab();
  const host = tab && tab.url ? extractHostname(tab.url) : null;
  const root = host ? reduceToRoot(host) : null;
  const isHttp = tab && tab.url && /^https?:/.test(tab.url);
  currentTabInfo = { tab, host, root, isHttp };

  $('#currentHost').textContent = host || '(no site)';

  const btn = $('#addCurrent');
  // 過去の onclick ハンドラをリセット（refresh 時の累積を防ぐ）
  btn.onclick = null;

  if (!isHttp || !root) {
    btn.disabled = true;
    btn.textContent = 'Not a regular page';
    return;
  }

  const stored = await ext.storage.local.get(['customSites', 'disabledBuiltins']);
  const customSites = Array.isArray(stored.customSites) ? stored.customSites : [];
  const disabledBuiltins = Array.isArray(stored.disabledBuiltins) ? stored.disabledBuiltins : [];

  if (isBuiltin(root)) {
    if (disabledBuiltins.includes(root)) {
      btn.disabled = false;
      btn.textContent = `+ Re-enable ${root}`;
      btn.onclick = () => enableBuiltinSite(root, tab.id);
    } else {
      // Firefox MV3 ではアップデート時に新規 host_permissions が自動付与されないので
      // 動作に必要な依存ホストが揃っているかを確認し、欠けていれば承認ボタンを出す
      const missing = await missingDeps(root);
      if (missing.length > 0) {
        btn.disabled = false;
        btn.textContent = `+ Grant permission (${missing.join(', ')})`;
        btn.onclick = () => grantBuiltinDeps(root, missing, tab.id);
      } else {
        btn.disabled = true;
        btn.textContent = 'Already supported (built-in)';
      }
    }
  } else if (customSites.includes(root)) {
    btn.disabled = true;
    btn.textContent = 'Already added';
  } else {
    btn.disabled = false;
    btn.textContent = `+ Add ${root}`;
    btn.onclick = () => addSite(root, tab.id);
  }
}

async function renderList() {
  const res = await bg({ type: 'listSites' });
  const customSites = (res && res.sites) || [];
  const disabledBuiltins = (res && res.disabledBuiltins) || [];
  const enabledBuiltins = BUILTIN.filter(b => !disabledBuiltins.includes(b));
  const allSites = [...enabledBuiltins, ...customSites].sort();

  const ul = $('#siteList');
  ul.replaceChildren();
  if (allSites.length === 0) {
    const li = document.createElement('li');
    li.className = 'ts-popup__empty';
    li.textContent = '(all sites disabled)';
    ul.appendChild(li);
    return;
  }
  for (const site of allSites) {
    const isBuiltinSite = BUILTIN.includes(site);
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = site;
    const btn = document.createElement('button');
    btn.textContent = '×';
    btn.title = isBuiltinSite ? `Disable ${site}` : `Remove ${site}`;
    btn.addEventListener('click', () => {
      if (isBuiltinSite) {
        disableBuiltinSite(site);
      } else {
        removeSite(site);
      }
    });
    li.appendChild(span);
    li.appendChild(btn);
    ul.appendChild(li);
  }
}

async function addSite(hostname, tabId) {
  setStatus('Requesting permission...');
  const origins = [`https://*.${hostname}/*`, `https://${hostname}/*`];
  let granted = false;
  try {
    granted = await ext.permissions.request({ origins });
  } catch (e) {
    setStatus(`Permission request failed: ${e.message || e}`, true);
    return;
  }
  if (!granted) {
    setStatus('Permission denied', true);
    return;
  }
  setStatus('Registering...');
  const res = await bg({ type: 'addSite', hostname });
  if (res && res.ok) {
    setStatus(`Added ${hostname} — reload tab to start`);
    // タブを自動リロード
    if (tabId) {
      try { await ext.tabs.reload(tabId); } catch (e) {}
    }
  } else {
    setStatus(`Failed: ${res && res.error ? res.error : 'unknown'}`, true);
  }
  await refresh();
}

async function removeSite(hostname) {
  setStatus('Removing...');
  const res = await bg({ type: 'removeSite', hostname });
  if (res && res.ok) {
    setStatus(`Removed ${hostname}`);
  } else {
    setStatus('Remove failed', true);
  }
  await refresh();
}

async function disableBuiltinSite(hostname) {
  setStatus('Disabling...');
  const res = await bg({ type: 'disableBuiltin', hostname });
  if (res && res.ok) {
    setStatus(`Disabled ${hostname}`);
    // 現在のタブが該当ホストなら自動リロード（パネルを消すため）
    if (currentTabInfo && currentTabInfo.root === hostname && currentTabInfo.tab) {
      try { await ext.tabs.reload(currentTabInfo.tab.id); } catch (e) {}
    }
  } else {
    setStatus('Disable failed', true);
  }
  await refresh();
}

async function grantBuiltinDeps(builtinHost, missing, tabId) {
  setStatus('Requesting permission...');
  const origins = missing.flatMap(originPatternsFor);
  let granted = false;
  try {
    granted = await ext.permissions.request({ origins });
  } catch (e) {
    setStatus(`Permission request failed: ${e.message || e}`, true);
    return;
  }
  if (!granted) {
    setStatus('Permission denied', true);
    return;
  }
  setStatus(`Granted ${missing.join(', ')} — reloading tab`);
  if (tabId) {
    try { await ext.tabs.reload(tabId); } catch (e) {}
  }
  await refresh();
}

async function enableBuiltinSite(hostname, tabId) {
  setStatus('Re-enabling...');
  const res = await bg({ type: 'enableBuiltin', hostname });
  if (res && res.ok) {
    setStatus(`Re-enabled ${hostname}`);
    if (tabId) {
      try { await ext.tabs.reload(tabId); } catch (e) {}
    }
  } else {
    setStatus('Re-enable failed', true);
  }
  await refresh();
}

refresh();
