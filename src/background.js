// TEMPO Slider - background service worker
//
// ユーザーが追加したカスタムサイトに対して以下を動的に管理:
//   - content.js / page-inject.js のコンテンツスクリプト登録 (chrome.scripting)
//   - CSP 除去 / CORS 付与の declarativeNetRequest 動的ルール
//   - chrome.storage.local への永続化（拡張機能の再起動後も復元）

// 予約済みホスト名（追加禁止）の判定関数を読み込む。
// Chrome MV3 service worker は importScripts、Firefox MV3 event page は
// manifest の background.scripts で同等の効果になる。
try { importScripts('reserved-hostnames.js'); } catch (e) { /* Firefox では scripts 配列で読み込まれているので無視 */ }

const STORAGE_KEY = 'customSites';
const DISABLED_BUILTINS_KEY = 'disabledBuiltins';
const DNR_RULE_ID_START = 1000;

// ---------- 永続化 ----------
async function loadCustomSites() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return Array.isArray(result[STORAGE_KEY]) ? result[STORAGE_KEY] : [];
}

async function saveCustomSites(sites) {
  await chrome.storage.local.set({ [STORAGE_KEY]: sites });
}

async function loadDisabledBuiltins() {
  const result = await chrome.storage.local.get(DISABLED_BUILTINS_KEY);
  return Array.isArray(result[DISABLED_BUILTINS_KEY]) ? result[DISABLED_BUILTINS_KEY] : [];
}

async function saveDisabledBuiltins(list) {
  await chrome.storage.local.set({ [DISABLED_BUILTINS_KEY]: list });
}

async function disableBuiltin(hostname) {
  const list = await loadDisabledBuiltins();
  if (!list.includes(hostname)) {
    list.push(hostname);
    await saveDisabledBuiltins(list);
  }
  return { ok: true };
}

async function enableBuiltin(hostname) {
  const list = await loadDisabledBuiltins();
  await saveDisabledBuiltins(list.filter(h => h !== hostname));
  return { ok: true };
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
        // fx-chain.js を content.js より前に読み込む（window.TempoSliderFX を先に用意）。
        // これが無いと state.fx が null になり、3バンドアイソレーターが非表示になる。
        js: ['fx-chain.js', 'content.js'],
        css: ['panel.css'],
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
      // CORS ヘッダー付与は <audio> の crossOrigin="anonymous" 経由再生のためだけに
      // 必要。xmlhttprequest や other に "*" を適用すると認証付き XHR の応答が
      // ブラウザに弾かれる（YouTube Studio のアップロード 0% 停止や Bandcamp の
      // ダウンロード生成失敗と同根のバグ）。静的 rules.json と同じく media のみ。
      condition: { urlFilter: `||${hostname}/`, resourceTypes: ['media'] },
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
  // 予約済みホスト名は追加しない。
  // 組み込み対応サイトや Google/CDN インフラに動的 DNR ルールが乗ると、
  // 認証付き CORS リクエスト（YouTube Studio アップロード等）が壊れる。
  if (typeof isReservedHostname === 'function' && isReservedHostname(hostname)) {
    return { ok: false, error: 'reserved_hostname' };
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
  let sites = await loadCustomSites();

  // 過去のバージョンで追加されてしまった予約済みホスト名を自動削除する。
  // youtube.com / google.com 等を customSites に持っているとアップロード
  // 等の認証付き CORS リクエストが壊れるため、検出次第クリーンアップする。
  if (typeof isReservedHostname === 'function') {
    const reservedFound = sites.filter(s => isReservedHostname(s));
    if (reservedFound.length > 0) {
      console.warn('[TEMPO Slider BG] Removing reserved hostnames from customSites:', reservedFound);
      for (const site of reservedFound) {
        await unregisterScriptsForSite(site);
        await removeDnrRulesForSite(site);
        try { await chrome.permissions.remove({ origins: originPatternsFor(site) }); } catch (e) {}
      }
      sites = sites.filter(s => !isReservedHostname(s));
      await saveCustomSites(sites);
    }
  }

  for (const site of sites) {
    const origins = originPatternsFor(site);
    const granted = await chrome.permissions.contains({ origins });
    if (granted) {
      await registerScriptsForSite(site);
      // 動的 DNR ルールはブラウザ再起動を跨いで永続するが、過去バージョンで
      // resourceTypes が広すぎたパターンが残っていると認証付き XHR を壊す。
      // 起動毎に最新の定義で再登録して古いパターンを上書きする。
      try { await addDnrRulesForSite(site); } catch (e) {
        console.warn('[TEMPO Slider BG] DNR re-register failed for', site, ':', e);
      }
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
    Promise.all([loadCustomSites(), loadDisabledBuiltins()])
      .then(([sites, disabledBuiltins]) => sendResponse({ ok: true, sites, disabledBuiltins }));
    return true;
  }
  if (msg.type === 'disableBuiltin') {
    disableBuiltin(msg.hostname).then(sendResponse);
    return true;
  }
  if (msg.type === 'enableBuiltin') {
    enableBuiltin(msg.hostname).then(sendResponse);
    return true;
  }
});
