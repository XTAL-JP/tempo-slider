// TEMPO Slider - background service worker
//
// ユーザーが追加したカスタムサイトに対して以下を動的に管理:
//   - content.js / page-inject.js のコンテンツスクリプト登録 (chrome.scripting)
//   - CSP 除去 / CORS 付与の declarativeNetRequest 動的ルール
//   - chrome.storage.local への永続化（拡張機能の再起動後も復元）

const STORAGE_KEY = 'customSites';
const DNR_RULE_ID_START = 1000;

// ---------- 永続化 ----------
async function loadCustomSites() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return Array.isArray(result[STORAGE_KEY]) ? result[STORAGE_KEY] : [];
}

async function saveCustomSites(sites) {
  await chrome.storage.local.set({ [STORAGE_KEY]: sites });
}

// ---------- ホスト名のパターン展開 ----------
function originPatternsFor(hostname) {
  // example.com → サブドメインも含めて両方カバー
  return [
    `https://*.${hostname}/*`,
    `https://${hostname}/*`,
  ];
}

// ---------- コンテンツスクリプト動的登録 ----------
async function registerScriptsForSite(hostname) {
  const ids = [`ts-content-${hostname}`, `ts-inject-${hostname}`];
  try { await chrome.scripting.unregisterContentScripts({ ids }); } catch (e) {}

  const matches = originPatternsFor(hostname);
  try {
    await chrome.scripting.registerContentScripts([
      {
        id: ids[0],
        matches,
        js: ['content.js'],
        runAt: 'document_idle',
      },
      {
        id: ids[1],
        matches,
        js: ['page-inject.js'],
        runAt: 'document_start',
        world: 'MAIN',
      },
    ]);
    return true;
  } catch (e) {
    console.warn('[TEMPO Slider BG] registerContentScripts failed:', e);
    return false;
  }
}

async function unregisterScriptsForSite(hostname) {
  const ids = [`ts-content-${hostname}`, `ts-inject-${hostname}`];
  try { await chrome.scripting.unregisterContentScripts({ ids }); } catch (e) {}
}

// ---------- DNR ルール動的追加 ----------
async function nextDnrIds(count) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const used = new Set(existing.map(r => r.id));
  const ids = [];
  let n = DNR_RULE_ID_START;
  while (ids.length < count) {
    if (!used.has(n)) ids.push(n);
    n++;
  }
  return ids;
}

async function addDnrRulesForSite(hostname) {
  // 既に同 hostname のルールがあれば一度削除
  await removeDnrRulesForSite(hostname);
  const ids = await nextDnrIds(2);
  const rules = [
    {
      id: ids[0],
      priority: 1,
      action: {
        type: 'modifyHeaders',
        responseHeaders: [
          { header: 'content-security-policy', operation: 'remove' },
          { header: 'content-security-policy-report-only', operation: 'remove' },
        ],
      },
      condition: { urlFilter: `||${hostname}/`, resourceTypes: ['main_frame', 'sub_frame'] },
    },
    {
      id: ids[1],
      priority: 1,
      action: {
        type: 'modifyHeaders',
        responseHeaders: [
          { header: 'access-control-allow-origin', operation: 'set', value: '*' },
        ],
      },
      condition: { urlFilter: `||${hostname}/`, resourceTypes: ['media', 'xmlhttprequest', 'other'] },
    },
  ];
  await chrome.declarativeNetRequest.updateDynamicRules({ addRules: rules });
}

async function removeDnrRulesForSite(hostname) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const filter = `||${hostname}/`;
  const toRemove = existing.filter(r => r.condition && r.condition.urlFilter === filter).map(r => r.id);
  if (toRemove.length > 0) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: toRemove });
  }
}

// ---------- 公開オペレーション ----------
async function addCustomSite(hostname) {
  hostname = (hostname || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(hostname)) {
    return { ok: false, error: 'invalid_hostname' };
  }
  const origins = originPatternsFor(hostname);
  const granted = await chrome.permissions.contains({ origins });
  if (!granted) return { ok: false, error: 'permission_not_granted' };

  const scriptOk = await registerScriptsForSite(hostname);
  if (!scriptOk) return { ok: false, error: 'script_register_failed' };

  try { await addDnrRulesForSite(hostname); } catch (e) {
    console.warn('[TEMPO Slider BG] DNR add failed:', e);
  }

  const sites = await loadCustomSites();
  if (!sites.includes(hostname)) {
    sites.push(hostname);
    await saveCustomSites(sites);
  }
  return { ok: true, hostname };
}

async function removeCustomSite(hostname) {
  await unregisterScriptsForSite(hostname);
  await removeDnrRulesForSite(hostname);
  const sites = await loadCustomSites();
  await saveCustomSites(sites.filter(s => s !== hostname));
  try {
    await chrome.permissions.remove({ origins: originPatternsFor(hostname) });
  } catch (e) {}
  return { ok: true };
}

// ---------- 起動時に復元 ----------
async function restoreCustomSites() {
  const sites = await loadCustomSites();
  for (const site of sites) {
    const origins = originPatternsFor(site);
    const granted = await chrome.permissions.contains({ origins });
    if (granted) {
      await registerScriptsForSite(site);
      // DNR の動的ルールはブラウザ再起動を超えて永続するので再追加不要
    } else {
      // 許可が剥奪されていたらクリーンアップ
      await unregisterScriptsForSite(site);
      await removeDnrRulesForSite(site);
      await saveCustomSites(sites.filter(s => s !== site));
    }
  }
}

chrome.runtime.onInstalled.addListener(restoreCustomSites);
chrome.runtime.onStartup.addListener(restoreCustomSites);

// ---------- メッセージハンドラ ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'tempo-slider-bg') return;
  if (msg.type === 'addSite') {
    addCustomSite(msg.hostname).then(sendResponse);
    return true;
  }
  if (msg.type === 'removeSite') {
    removeCustomSite(msg.hostname).then(sendResponse);
    return true;
  }
  if (msg.type === 'listSites') {
    loadCustomSites().then(sites => sendResponse({ ok: true, sites }));
    return true;
  }
});
