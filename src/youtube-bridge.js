// TEMPO Slider - youtube-bridge content script
//
// YouTube iframe（discogs 等の埋め込み元から呼ばれる）内で動作。
// 親フレームから postMessage で受けたコマンドに従い、
//   - video.playbackRate でテンポ変更
//   - MASTER TEMPO 時は video.preservesPitch（ブラウザ標準）でピッチキープ
// を実行する。FX（DJM 風エフェクト）使用時のみ AudioContext + Web Audio グラフを構築する。

(() => {
  'use strict';

  const ext = (typeof browser !== 'undefined') ? browser : chrome;
  const MSG_TAG = '__tempoSliderBridge';

  // 親フレームの許可オリジン判定。
  // postMessage はそもそも親フレーム（または同オリジン）からしか到達しないので、
  // 任意の HTTPS オリジンを許可しても外部からの不正操作は構造上できない
  // （リスクは「自分の埋め込み YouTube の再生速度を変えられる」程度で副作用なし）。
  // discogs / custom サイトの未知のホスト両方に対応するため広く許可する。
  function isAllowedParentOrigin(origin) {
    if (!origin) return false;
    try {
      const u = new URL(origin);
      return u.protocol === 'https:';
    } catch {
      return false;
    }
  }

  let currentRate = 1.0;
  let masterTempo = false;
  let audioCtx = null;
  let sourceNode = null;
  let gainNode = null;
  let workletLoaded = false;
  let graphedVideo = null;
  let observedVideo = null;
  // FX（DJM 風エフェクトユニット）
  let fxChain = null;
  let fxParams = null;
  let fxBpm = null;

  // FX に有効なエフェクトが 1 つでもあるか（グラフ構築要否の判定）
  function fxActive() {
    if (!fxParams) return false;
    return fxParams.filter.on || fxParams.iso.on
      || fxParams.echo.on || fxParams.trans.on || fxParams.flanger.on
      || fxParams.reverb.on || fxParams.crush.on || fxParams.pitch.on;
  }

  function getVideo() {
    return document.querySelector('video');
  }

  // applyRate は MutationObserver のループ起因リセットも自分で観測してしまうため、
  // 不要な再代入を避ける（attribute change の発火回数を最小化）
  function applyRate(video) {
    if (!video) return false;
    try {
      // MASTER TEMPO のピッチキープはブラウザ標準の preservesPitch で行う（native 方式）。
      //   ON  → preservesPitch=true（テンポだけ変えピッチ維持＝MASTER TEMPO）
      //   OFF → preservesPitch=false（バイナル風にピッチも上下＝CDJ 非 MASTER TEMPO）
      // rubberband worklet + createMediaElementSource 経路は Firefox で無音になることがあり、
      // native 方式なら全ブラウザで確実に音が出る。
      const want = !!masterTempo;
      if (video.preservesPitch !== want) video.preservesPitch = want;
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
      // FX チェーンを 1 度だけ構築（失敗しても音が途切れないよう防御的に）
      if (!fxChain && window.TempoSliderFX) {
        try {
          fxChain = window.TempoSliderFX.create(audioCtx, { rubberbandReady: workletLoaded });
          if (fxParams) fxChain.setParams(fxParams, fxBpm);
        } catch (e) {
          console.warn('[TEMPO Slider bridge] FX チェーン生成失敗（FX なしで継続）:', e);
          fxChain = null;
        }
      }
      rebuildGraph();
      return true;
    } catch (e) {
      console.warn('[TEMPO Slider bridge] graph build failed:', e);
      return false;
    }
  }

  // グラフは FX 専用。MASTER TEMPO のピッチキープは preservesPitch（native）で行うため
  // ここでは rubberband worklet を挿入しない（Firefox 無音対策）。
  function rebuildGraph() {
    if (!sourceNode) return;
    try { sourceNode.disconnect(); } catch {}
    try { gainNode.disconnect(); } catch {}
    if (fxChain) { try { fxChain.output.disconnect(); } catch {} }

    gainNode.gain.setValueAtTime(1.0, audioCtx.currentTime);

    if (fxChain) {
      sourceNode.connect(fxChain.input);
      fxChain.output.connect(gainNode);
    } else {
      sourceNode.connect(gainNode);
    }
    gainNode.connect(audioCtx.destination);
  }

  // FX パラメータ適用（必要ならグラフ構築）
  async function setFx(fx, bpm) {
    fxParams = fx;
    if (typeof bpm === 'number') fxBpm = bpm;
    // FX に有効なものがあり、まだグラフが無ければ構築する（masterTempo OFF でも FX を効かせる）
    if (fxActive() && !fxChain) {
      const ok = await ensureGraph();
      if (!ok) return false;
    }
    if (fxChain) fxChain.setParams(fxParams, fxBpm);
    return true;
  }

  async function setMasterTempo(on) {
    if (on === masterTempo) return true;
    // native 方式: preservesPitch を切り替えるだけ。Web Audio グラフ（FX 用）は不要で、
    // FX が有効なときのグラフはそのまま流用できる（preservesPitch は取り込み前の
    // デコード段に効くため、グラフ経由でも native ピッチキープが有効になる）。
    masterTempo = !!on;
    applyRate(getVideo());
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
          // テンポ反映＋ preservesPitch（MASTER TEMPO のピッチキープ）を native に適用
          applyRate(getVideo());
        }
        break;
      case 'setMasterTempo': {
        const ok = await setMasterTempo(!!data.on);
        try {
          e.source.postMessage(
            JSON.stringify({ [MSG_TAG]: true, type: 'masterTempoResult', ok }),
            e.origin
          );
        } catch (err) {}
        break;
      }
      case 'setFx':
        if (data.fx) { await setFx(data.fx, typeof data.bpm === 'number' ? data.bpm : undefined); }
        break;
      case 'setFxBpm':
        if (typeof data.bpm === 'number') {
          fxBpm = data.bpm;
          if (fxChain) fxChain.updateBpm(fxBpm);
        }
        break;
      case 'ping':
        try {
          e.source.postMessage(
            JSON.stringify({ [MSG_TAG]: true, type: 'pong', hasVideo: !!getVideo(), currentRate, masterTempo }),
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
      window.parent.postMessage(JSON.stringify({ [MSG_TAG]: true, type: 'bridgeReady' }), '*');
      console.log('[TEMPO Slider bridge] sent bridgeReady to parent');
    }
  } catch {}
})();
