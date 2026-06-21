// TEMPO Slider - page inject (MAIN world)
//
// HTML <audio> 要素を DOM 外で使うサイト (Beatport 等) に対応するため、
// メインワールドで Audio / createElement / AudioContext をモンキーパッチして
// 作成された要素・ノードを捕捉し、playbackRate と Web Audio グラフを制御する。

(() => {
  'use strict';

  if (window.__tempoSliderInjected) return;
  window.__tempoSliderInjected = true;

  const MSG_TAG = '__tempoSlider';

  // 状態
  let currentRate = 1.0;
  let masterTempoOn = false;
  let workletUrl = null;
  let workletLoaded = false;

  // 捕捉した要素
  const activeBufferSources = new Set();
  const activeMediaElements = new Set();
  // 要素ごとの Web Audio グラフ
  const elementGraphs = new Map(); // HTMLMediaElement → {ctx, source, worklet, gain}
  let sharedAudioContext = null;

  function ensureAudioContext() {
    if (!sharedAudioContext) {
      sharedAudioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    return sharedAudioContext;
  }

  async function ensureWorklet() {
    if (workletLoaded || !workletUrl) return workletLoaded;
    const ctx = ensureAudioContext();
    try {
      await ctx.audioWorklet.addModule(workletUrl);
      workletLoaded = true;
    } catch (e) {
      console.warn('[TEMPO Slider] worklet load failed:', e);
    }
    return workletLoaded;
  }

  function registerBufferSource(source) {
    if (!source) return;
    activeBufferSources.add(source);
    try { source.playbackRate.value = currentRate; } catch (e) {}
    try { source.addEventListener('ended', () => activeBufferSources.delete(source)); } catch (e) {}
  }

  function prepareMediaElement(el) {
    if (!el) return;
    try { el.crossOrigin = 'anonymous'; } catch (e) {}
    try { el.preservesPitch = false; } catch (e) {}
  }

  function registerMediaElement(el) {
    if (!el || activeMediaElements.has(el)) return;
    activeMediaElements.add(el);
    // defaultPlaybackRate も設定しておくと、次曲ロード時に
    // ブラウザがリソース選択アルゴリズムで playbackRate をリセットする際、
    // リセット先がテンポ比率になりテンポが維持される
    try { el.defaultPlaybackRate = currentRate; } catch (e) {}
    try { el.playbackRate = currentRate; } catch (e) {}
    try { el.preservesPitch = false; } catch (e) {}

    // MASTER TEMPO が ON の状態で新しい要素が登録されたら、グラフも準備
    if (masterTempoOn) {
      setupElementGraph(el).catch(e => console.warn('[TEMPO Slider] graph setup failed:', e));
    }
  }

  // 要素を Web Audio グラフに乗せる
  async function setupElementGraph(el) {
    if (elementGraphs.has(el)) return elementGraphs.get(el);
    const ctx = ensureAudioContext();
    await ensureWorklet();
    let source;
    try {
      source = ctx.createMediaElementSource(el);
    } catch (e) {
      // 既に MediaElementSource が作成済みの場合エラー → スキップ
      console.warn('[TEMPO Slider] createMediaElementSource failed (already attached?):', e);
      return null;
    }
    const gain = ctx.createGain();
    const graph = { ctx, source, worklet: null, gain };
    elementGraphs.set(el, graph);
    // 初期接続 (worklet バイパス)
    source.connect(gain);
    gain.connect(ctx.destination);
    // MASTER TEMPO が既に ON ならすぐ worklet を挿入
    if (masterTempoOn && workletLoaded) {
      enableWorkletForGraph(graph);
    }
    return graph;
  }

  function enableWorkletForGraph(graph) {
    if (!graph || graph.worklet || !workletLoaded) return;
    try {
      graph.worklet = new AudioWorkletNode(graph.ctx, 'rubberband-processor');
      graph.worklet.port.onmessage = () => {};
      graph.worklet.port.postMessage(JSON.stringify(['quality', true]));
      graph.worklet.port.postMessage(JSON.stringify(['pitch', 1 / currentRate]));
      // source → worklet → gain
      try { graph.source.disconnect(); } catch (e) {}
      graph.source.connect(graph.worklet);
      graph.worklet.connect(graph.gain);
    } catch (e) {
      console.warn('[TEMPO Slider] worklet enable failed:', e);
    }
  }

  function disableWorkletForGraph(graph) {
    if (!graph || !graph.worklet) return;
    try { graph.source.disconnect(); } catch (e) {}
    try { graph.worklet.disconnect(); } catch (e) {}
    graph.worklet = null;
    graph.source.connect(graph.gain);
  }

  // ============================================================
  // パッチ
  // ============================================================

  // AudioContext.createBufferSource
  function patchContext(Ctor) {
    if (!Ctor || !Ctor.prototype) return;
    const orig = Ctor.prototype.createBufferSource;
    if (!orig || orig.__tempoSliderPatched) return;
    Ctor.prototype.createBufferSource = function patchedCreateBufferSource() {
      const source = orig.apply(this, arguments);
      registerBufferSource(source);
      return source;
    };
    Ctor.prototype.createBufferSource.__tempoSliderPatched = true;
  }
  patchContext(window.AudioContext);
  patchContext(window.webkitAudioContext);

  // AudioBufferSourceNode (Proxy)
  if (window.AudioBufferSourceNode && !window.AudioBufferSourceNode.__tempoSliderPatched) {
    const Orig = window.AudioBufferSourceNode;
    const Proxied = new Proxy(Orig, {
      construct(target, args, newTarget) {
        const source = Reflect.construct(target, args, newTarget);
        registerBufferSource(source);
        return source;
      }
    });
    Proxied.__tempoSliderPatched = true;
    try { window.AudioBufferSourceNode = Proxied; } catch (e) {}
  }

  // Audio コンストラクタ (Proxy) - crossOrigin を src 代入前にセット
  if (window.Audio && !window.Audio.__tempoSliderPatched) {
    const OrigAudio = window.Audio;
    const Patched = new Proxy(OrigAudio, {
      construct(target, args, newTarget) {
        // 引数なしで構築し crossOrigin を即時セット、その後 src を代入
        const el = Reflect.construct(target, [], newTarget);
        prepareMediaElement(el);
        if (args.length > 0 && args[0]) {
          try { el.src = args[0]; } catch (e) {}
        }
        registerMediaElement(el);
        return el;
      }
    });
    Patched.__tempoSliderPatched = true;
    try { window.Audio = Patched; } catch (e) {}
  }

  // document.createElement('audio'|'video') - 作成時に crossOrigin
  if (document.createElement && !document.createElement.__tempoSliderPatched) {
    const orig = document.createElement.bind(document);
    const patched = function patchedCreateElement(tagName, options) {
      const el = orig(tagName, options);
      if (typeof tagName === 'string') {
        const t = tagName.toLowerCase();
        if (t === 'audio' || t === 'video') {
          prepareMediaElement(el);
          // src は後から set されるので、register は play() でも行う
        }
      }
      return el;
    };
    patched.__tempoSliderPatched = true;
    try { document.createElement = patched; } catch (e) {}
  }

  // HTMLMediaElement.play() - 全要素を捕捉
  if (window.HTMLMediaElement && !HTMLMediaElement.prototype.play.__tempoSliderPatched) {
    const origPlay = HTMLMediaElement.prototype.play;
    const patchedPlay = function patchedPlay() {
      registerMediaElement(this);
      return origPlay.apply(this, arguments);
    };
    patchedPlay.__tempoSliderPatched = true;
    HTMLMediaElement.prototype.play = patchedPlay;
  }

  // ============================================================
  // テンポ・ピッチ適用
  // ============================================================
  function applyRate(rate) {
    currentRate = rate;
    let applied = 0;
    for (const src of activeBufferSources) {
      try { src.playbackRate.value = rate; applied++; } catch (e) {}
    }
    for (const el of activeMediaElements) {
      try { el.defaultPlaybackRate = rate; } catch (e) {}
      try { el.playbackRate = rate; applied++; } catch (e) {}
    }
    // MASTER TEMPO ON のときは worklet にもピッチを送る (= 1/rate)
    if (masterTempoOn) {
      const pitch = 1 / rate;
      for (const graph of elementGraphs.values()) {
        if (graph.worklet) {
          try { graph.worklet.port.postMessage(JSON.stringify(['pitch', pitch])); } catch (e) {}
        }
      }
    }
    return applied;
  }

  async function setMasterTempo(on) {
    if (on === masterTempoOn) return true;
    masterTempoOn = on;

    if (on) {
      // すべての登録済み要素をグラフ化して worklet を有効化
      await ensureWorklet();
      for (const el of activeMediaElements) {
        const graph = await setupElementGraph(el);
        if (graph) enableWorkletForGraph(graph);
      }
    } else {
      for (const graph of elementGraphs.values()) {
        disableWorkletForGraph(graph);
      }
    }
    return true;
  }

  // ============================================================
  // メッセージ通信
  // ============================================================
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const data = e.data;
    if (!data || data[MSG_TAG] !== true) return;

    switch (data.type) {
      case 'init':
        if (data.workletUrl) workletUrl = data.workletUrl;
        break;
      case 'setRate':
        if (typeof data.rate === 'number' && isFinite(data.rate)) {
          applyRate(data.rate);
        }
        break;
      case 'setMasterTempo':
        setMasterTempo(!!data.on).then(ok => {
          window.postMessage({ [MSG_TAG]: true, type: 'masterTempoResult', ok }, '*');
        });
        break;
      case 'ping':
        window.postMessage({
          [MSG_TAG]: true, type: 'pong',
          activeBuffer: activeBufferSources.size,
          activeMedia: activeMediaElements.size,
          graphedElements: elementGraphs.size,
          currentRate, masterTempoOn, workletLoaded
        }, '*');
        break;
    }
  });

  window.__tempoSliderDebug = {
    get state() {
      return {
        activeBuffer: activeBufferSources.size,
        activeMedia: activeMediaElements.size,
        graphedElements: elementGraphs.size,
        currentRate, masterTempoOn, workletLoaded, workletUrl,
        mediaElements: [...activeMediaElements].map(el => ({
          src: el.currentSrc || el.src,
          paused: el.paused,
          rate: el.playbackRate,
          crossOrigin: el.crossOrigin
        }))
      };
    },
    forceRate(r) { return applyRate(r); }
  };

  console.log('[TEMPO Slider] page-inject loaded');
  window.postMessage({ [MSG_TAG]: true, type: 'inject-ready' }, '*');
})();
