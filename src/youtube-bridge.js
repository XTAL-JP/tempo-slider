// TEMPO Slider - youtube-bridge content script
//
// YouTube iframe（discogs 等の埋め込み元から呼ばれる）内で動作。
// 親フレームから postMessage で受けたコマンドに従い、
//   - video.playbackRate でテンポ変更
//   - MASTER TEMPO 時は AudioContext + Rubber Band Worklet でピッチキープ
// を実行する。

(() => {
  'use strict';

  const ext = (typeof browser !== 'undefined') ? browser : chrome;
  const MSG_TAG = '__tempoSliderBridge';

  // 親フレームの許可オリジン判定（discogs.com 配下の任意サブドメインを許可）
  function isAllowedParentOrigin(origin) {
    if (!origin) return false;
    try {
      const u = new URL(origin);
      if (u.protocol !== 'https:') return false;
      const h = u.hostname;
      return h === 'discogs.com' || h.endsWith('.discogs.com');
    } catch {
      return false;
    }
  }

  let currentRate = 1.0;
  let masterTempo = false;
  let audioCtx = null;
  let sourceNode = null;
  let workletNode = null;
  let gainNode = null;
  let workletLoaded = false;
  let graphedVideo = null;
  let observedVideo = null;

  function getVideo() {
    return document.querySelector('video');
  }

  // applyRate は MutationObserver のループ起因リセットも自分で観測してしまうため、
  // 不要な再代入を避ける（attribute change の発火回数を最小化）
  function applyRate(video) {
    if (!video) return false;
    try {
      // MASTER TEMPO OFF 時はブラウザ標準のピッチキープを切り、
      // バイナル風の挙動にする（CDJ 非 MASTER TEMPO 仕様に合わせる）
      if (video.preservesPitch !== false) video.preservesPitch = false;
    } catch {}
    let changed = false;
    try {
      if (video.defaultPlaybackRate !== currentRate) {
        video.defaultPlaybackRate = currentRate;
        changed = true;
      }
    } catch {}
    try {
      if (video.playbackRate !== currentRate) {
        video.playbackRate = currentRate;
        changed = true;
      }
    } catch {}
    return changed;
  }

  async function ensureWorklet() {
    if (workletLoaded) return true;
    if (!audioCtx) audioCtx = new AudioContext();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    try {
      await audioCtx.audioWorklet.addModule(ext.runtime.getURL('rubberband-worklet.js'));
      workletLoaded = true;
      return true;
    } catch (e) {
      console.warn('[TEMPO Slider bridge] worklet load failed:', e);
      return false;
    }
  }

  async function ensureGraph() {
    const video = getVideo();
    if (!video) return false;
    if (graphedVideo === video && sourceNode) {
      if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {});
      }
      return true;
    }
    if (!audioCtx) audioCtx = new AudioContext();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});

    if (!workletLoaded) await ensureWorklet();

    try {
      // YouTube の <video> は MSE 経由（blob: URL）のため、
      // CORS タイント対象外で createMediaElementSource は成功する
      sourceNode = audioCtx.createMediaElementSource(video);
      gainNode = audioCtx.createGain();
      graphedVideo = video;
      rebuildGraph();
      return true;
    } catch (e) {
      console.warn('[TEMPO Slider bridge] graph build failed:', e);
      return false;
    }
  }

  function rebuildGraph() {
    if (!sourceNode) return;
    try { sourceNode.disconnect(); } catch {}
    try { gainNode.disconnect(); } catch {}
    if (workletNode) {
      try { workletNode.disconnect(); } catch {}
      workletNode = null;
    }

    gainNode.gain.setValueAtTime(1.0, audioCtx.currentTime);

    if (masterTempo && workletLoaded) {
      try {
        workletNode = new AudioWorkletNode(audioCtx, 'rubberband-processor');
        workletNode.port.postMessage(JSON.stringify(['quality', true]));
        workletNode.port.postMessage(JSON.stringify(['pitch', 1 / currentRate]));
        sourceNode.connect(workletNode);
        workletNode.connect(gainNode);
      } catch (e) {
        console.warn('[TEMPO Slider bridge] worklet node create failed:', e);
        sourceNode.connect(gainNode);
      }
    } else {
      sourceNode.connect(gainNode);
    }
    gainNode.connect(audioCtx.destination);
  }

  async function setMasterTempo(on) {
    if (on === masterTempo) return true;
    if (on) {
      const ok = await ensureGraph();
      if (!ok) return false;
      masterTempo = true;
      rebuildGraph();
    } else {
      masterTempo = false;
      if (sourceNode) rebuildGraph();
    }
    return true;
  }

  // YouTube プレーヤーは <video> の playbackRate を自前で書き換えることがあるので、
  // attribute 変化を観測して都度上書きする
  function observeVideo() {
    const video = getVideo();
    if (!video || observedVideo === video) return;
    observedVideo = video;
    applyRate(video);
    new MutationObserver(() => applyRate(video))
      .observe(video, { attributes: true });
  }

  // <video> 出現を待つ（YouTube は iframe 読み込み後に DOM 追加されるため）
  function waitForVideo(attempts = 60) {
    if (getVideo()) {
      observeVideo();
      return;
    }
    if (attempts <= 0) return;
    setTimeout(() => waitForVideo(attempts - 1), 250);
  }

  // 親フレームからのメッセージ
  window.addEventListener('message', async (e) => {
    if (!isAllowedParentOrigin(e.origin)) return;
    if (!e.data) return;
    let data;
    try {
      data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
    } catch { return; }
    if (!data || data[MSG_TAG] !== true) return;

    switch (data.type) {
      case 'setRate':
        if (typeof data.rate === 'number' && isFinite(data.rate) && data.rate > 0) {
          currentRate = data.rate;
          applyRate(getVideo());
          if (masterTempo && workletNode) {
            workletNode.port.postMessage(JSON.stringify(['pitch', 1 / currentRate]));
          }
        }
        break;
      case 'setMasterTempo': {
        const ok = await setMasterTempo(!!data.on);
        try {
          e.source.postMessage(
            { [MSG_TAG]: true, type: 'masterTempoResult', ok },
            e.origin
          );
        } catch (err) {}
        break;
      }
      case 'ping':
        try {
          e.source.postMessage(
            { [MSG_TAG]: true, type: 'pong', hasVideo: !!getVideo(), currentRate, masterTempo },
            e.origin
          );
        } catch (err) {}
        break;
    }
  });

  console.log('[TEMPO Slider bridge] loaded in', location.href);

  waitForVideo();

  // Worklet を事前ロード（user gesture を消費しないように）
  ensureWorklet().catch(() => {});

  // 親フレームに自分の存在を通知し、現在のテンポ／MASTER TEMPO 状態をもらう
  // （新規 iframe 出現や src 変更でリロードされた場合のステート同期用）
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ [MSG_TAG]: true, type: 'bridgeReady' }, '*');
      console.log('[TEMPO Slider bridge] sent bridgeReady to parent');
    }
  } catch {}
})();
