// TEMPO Slider - bandcamp-bridge content script
//
// bandcamp.com/EmbeddedPlayer/* iframe 内で動作。
// 親フレーム（lighthouserecords.jp 等の custom サイト）からの postMessage を受け、
//   - audio.playbackRate でテンポ変更
//   - MASTER TEMPO 時は AudioContext + Rubber Band Worklet でピッチキープ
// を実行する。youtube-bridge.js と同じプロトコル。

(() => {
  'use strict';

  // top frame で動作している場合は、通常の content.js（パネル付き）の担当範囲なので
  // bridge は何もしない（panel 重複や処理競合を避ける）
  if (window.top === window) return;

  const ext = (typeof browser !== 'undefined') ? browser : chrome;
  const MSG_TAG = '__tempoSliderBridge';

  // 親フレームの許可オリジン判定（任意の HTTPS オリジンを許可）。
  // postMessage は親フレーム以外からは到達できないため、広く許可しても
  // 外部からの不正操作リスクは構造上存在しない。
  function isAllowedParentOrigin(origin) {
    if (!origin) return false;
    try {
      return new URL(origin).protocol === 'https:';
    } catch {
      return false;
    }
  }

  let currentRate = 1.0;
  let masterTempo = false;
  let audioCtx = null;
  let workletLoaded = false;
  // 要素ごとに Web Audio グラフを保持（複数 <audio> が存在しうる）
  const graphs = new Map(); // HTMLAudioElement -> {source, worklet, gain, fx}
  const hookedElements = new Set();
  // FX（DJM 風エフェクトユニット）
  let fxParams = null;
  let fxBpm = null;

  function fxActive() {
    if (!fxParams) return false;
    return fxParams.filter.on || fxParams.iso.on
      || fxParams.echo.on || fxParams.trans.on || fxParams.flanger.on
      || fxParams.reverb.on || fxParams.crush.on || fxParams.pitch.on;
  }

  // グラフの結線を一元管理: source →[worklet]→[fx]→ gain（gain→destination は生成時に接続済み）
  function wireGraph(graph) {
    if (!graph) return;
    try { graph.source.disconnect(); } catch {}
    if (graph.worklet) { try { graph.worklet.disconnect(); } catch {} }
    if (graph.fx) { try { graph.fx.output.disconnect(); } catch {} }
    let preFx = graph.source;
    if (graph.worklet) { graph.source.connect(graph.worklet); preFx = graph.worklet; }
    if (graph.fx) {
      preFx.connect(graph.fx.input);
      graph.fx.output.connect(graph.gain);
    } else {
      preFx.connect(graph.gain);
    }
  }

  function findAudioElements() {
    return Array.from(document.querySelectorAll('audio'));
  }

  function applyRate(el) {
    if (!el) return;
    try { el.preservesPitch = false; } catch {}
    try { el.defaultPlaybackRate = currentRate; } catch {}
    try { el.playbackRate = currentRate; } catch {}
  }

  function hookAudio(el) {
    if (!el || hookedElements.has(el)) return;
    hookedElements.add(el);
    applyRate(el);
    // 曲切り替えで playbackRate がリセットされても再適用する
    el.addEventListener('loadstart', () => applyRate(el));
    el.addEventListener('durationchange', () => applyRate(el));
  }

  function watchAudio() {
    for (const el of findAudioElements()) hookAudio(el);
    new MutationObserver(() => {
      for (const el of findAudioElements()) hookAudio(el);
    }).observe(document.documentElement, { childList: true, subtree: true });
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
      console.warn('[TEMPO Slider bandcamp-bridge] worklet load failed:', e);
      return false;
    }
  }

  async function ensureGraphForElement(el) {
    if (!el) return null;
    if (graphs.has(el)) return graphs.get(el);
    if (!audioCtx) audioCtx = new AudioContext();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    await ensureWorklet();

    // bcbits.com 音源は同一オリジンではないため crossOrigin を立ててリロードする必要がある。
    // 親 content.js での Bandcamp 処理と同じパターン。
    if (!el.crossOrigin) {
      const wasPlaying = !el.paused;
      const savedTime = el.currentTime;
      try {
        el.crossOrigin = 'anonymous';
        el.load();
        try { el.currentTime = savedTime; } catch {}
        if (wasPlaying) el.play().catch(() => {});
      } catch (e) {}
    }
    try { el.preservesPitch = false; } catch {}

    let source;
    try {
      source = audioCtx.createMediaElementSource(el);
    } catch (e) {
      console.warn('[TEMPO Slider bandcamp-bridge] createMediaElementSource failed:', e);
      return null;
    }
    const gain = audioCtx.createGain();
    const graph = { source, worklet: null, gain, fx: null };
    graphs.set(el, graph);
    // FX チェーンを構築（失敗しても音が途切れないよう防御的に）
    if (window.TempoSliderFX) {
      try {
        graph.fx = window.TempoSliderFX.create(audioCtx, { rubberbandReady: workletLoaded });
        if (fxParams) graph.fx.setParams(fxParams, fxBpm);
      } catch (e) {
        console.warn('[TEMPO Slider bandcamp-bridge] FX チェーン生成失敗（FX なしで継続）:', e);
        graph.fx = null;
      }
    }
    gain.connect(audioCtx.destination);
    if (masterTempo && workletLoaded) enableWorkletForGraph(graph);
    else wireGraph(graph);
    return graph;
  }

  function enableWorkletForGraph(graph) {
    if (!graph || graph.worklet || !workletLoaded) return;
    try {
      graph.worklet = new AudioWorkletNode(audioCtx, 'rubberband-processor');
      graph.worklet.port.postMessage(JSON.stringify(['quality', true]));
      graph.worklet.port.postMessage(JSON.stringify(['pitch', 1 / currentRate]));
    } catch (e) {
      console.warn('[TEMPO Slider bandcamp-bridge] worklet node create failed:', e);
      graph.worklet = null;
    }
    wireGraph(graph);
  }

  function disableWorkletForGraph(graph) {
    if (!graph) return;
    if (graph.worklet) {
      try { graph.worklet.disconnect(); } catch {}
      graph.worklet = null;
    }
    wireGraph(graph);
  }

  // FX パラメータ適用（必要ならグラフ構築）
  async function setFx(fx, bpm) {
    fxParams = fx;
    if (typeof bpm === 'number') fxBpm = bpm;
    if (fxActive() && graphs.size === 0) {
      await ensureWorklet();
      for (const el of hookedElements) await ensureGraphForElement(el);
    }
    for (const g of graphs.values()) {
      if (g.fx) g.fx.setParams(fxParams, fxBpm);
    }
    return true;
  }

  async function setMasterTempo(on) {
    if (on === masterTempo) return true;
    masterTempo = on;
    if (on) {
      await ensureWorklet();
      // 既に再生中（activeElement にあたるもの）を中心に、全要素分のグラフを構築
      for (const el of hookedElements) {
        const g = await ensureGraphForElement(el);
        if (g) enableWorkletForGraph(g);
      }
    } else {
      for (const g of graphs.values()) disableWorkletForGraph(g);
    }
    return true;
  }

  function setRate(rate) {
    currentRate = rate;
    for (const el of hookedElements) applyRate(el);
    if (masterTempo) {
      const pitch = 1 / currentRate;
      for (const g of graphs.values()) {
        if (g.worklet) {
          try { g.worklet.port.postMessage(JSON.stringify(['pitch', pitch])); } catch {}
        }
      }
    }
  }

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
          setRate(data.rate);
        }
        break;
      case 'setMasterTempo': {
        const ok = await setMasterTempo(!!data.on);
        try {
          e.source.postMessage(
            JSON.stringify({ [MSG_TAG]: true, type: 'masterTempoResult', ok }),
            e.origin
          );
        } catch {}
        break;
      }
      case 'setFx':
        if (data.fx) { await setFx(data.fx, typeof data.bpm === 'number' ? data.bpm : undefined); }
        break;
      case 'setFxBpm':
        if (typeof data.bpm === 'number') {
          fxBpm = data.bpm;
          for (const g of graphs.values()) { if (g.fx) g.fx.updateBpm(fxBpm); }
        }
        break;
      case 'ping':
        try {
          e.source.postMessage(
            JSON.stringify({
              [MSG_TAG]: true, type: 'pong',
              hookedAudio: hookedElements.size,
              graphs: graphs.size,
              currentRate, masterTempo
            }),
            e.origin
          );
        } catch {}
        break;
    }
  });

  console.log('[TEMPO Slider bandcamp-bridge] loaded in', location.href);

  watchAudio();

  // worklet を事前ロード（user gesture を消費しないように）
  ensureWorklet().catch(() => {});

  // 親フレームに自分の存在を通知し、現在のテンポ／MASTER TEMPO 状態をもらう
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage(JSON.stringify({ [MSG_TAG]: true, type: 'bridgeReady' }), '*');
      console.log('[TEMPO Slider bandcamp-bridge] sent bridgeReady to parent');
    }
  } catch {}
})();
