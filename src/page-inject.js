// TEMPO Slider - page inject (MAIN world)
//
// HTML <audio> 要素を使わず Web Audio API で直接再生するサイト（Beatport 等）に対応するため、
// ページのメインワールドに注入され、AudioContext.createBufferSource と
// AudioBufferSourceNode コンストラクタをモンキーパッチして、作成された
// AudioBufferSourceNode の playbackRate を一括制御する。

(() => {
  'use strict';

  if (window.__tempoSliderInjected) return;
  window.__tempoSliderInjected = true;

  const MSG_TAG = '__tempoSlider';
  let currentRate = 1.0;
  const activeSources = new Set();
  let patchedCount = 0;

  function registerSource(source) {
    if (!source) return;
    activeSources.add(source);
    patchedCount++;
    try { source.playbackRate.value = currentRate; } catch (e) {}
    try {
      source.addEventListener('ended', () => activeSources.delete(source));
    } catch (e) {}
  }

  function patchContext(Ctor) {
    if (!Ctor || !Ctor.prototype) return;
    const orig = Ctor.prototype.createBufferSource;
    if (!orig || orig.__tempoSliderPatched) return;
    Ctor.prototype.createBufferSource = function patchedCreateBufferSource() {
      const source = orig.apply(this, arguments);
      registerSource(source);
      return source;
    };
    Ctor.prototype.createBufferSource.__tempoSliderPatched = true;
  }

  patchContext(window.AudioContext);
  patchContext(window.webkitAudioContext);

  // AudioBufferSourceNode コンストラクタも Proxy で包む（new での生成を捕捉）
  if (window.AudioBufferSourceNode && !window.AudioBufferSourceNode.__tempoSliderPatched) {
    const Orig = window.AudioBufferSourceNode;
    const Proxied = new Proxy(Orig, {
      construct(target, args, newTarget) {
        const source = Reflect.construct(target, args, newTarget);
        registerSource(source);
        return source;
      }
    });
    Proxied.__tempoSliderPatched = true;
    try {
      window.AudioBufferSourceNode = Proxied;
    } catch (e) {
      console.warn('[TEMPO Slider] AudioBufferSourceNode の置換失敗:', e);
    }
  }

  function applyRate(rate) {
    currentRate = rate;
    let applied = 0;
    for (const src of activeSources) {
      try {
        src.playbackRate.value = rate;
        applied++;
      } catch (e) {}
    }
    return applied;
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const data = e.data;
    if (!data || data[MSG_TAG] !== true) return;

    switch (data.type) {
      case 'setRate':
        if (typeof data.rate === 'number' && isFinite(data.rate)) {
          const applied = applyRate(data.rate);
          console.log(`[TEMPO Slider] setRate(${data.rate}) → ${applied}/${activeSources.size} sources`);
        }
        break;
      case 'ping':
        window.postMessage({
          [MSG_TAG]: true,
          type: 'pong',
          totalCreated: patchedCount,
          activeCount: activeSources.size,
          currentRate
        }, '*');
        break;
    }
  });

  // デバッグ用に状態を window に露出
  window.__tempoSliderDebug = {
    get state() {
      return {
        totalCreated: patchedCount,
        activeCount: activeSources.size,
        currentRate,
        patched: {
          createBufferSource: !!AudioContext.prototype.createBufferSource.__tempoSliderPatched,
          AudioBufferSourceNode: !!window.AudioBufferSourceNode.__tempoSliderPatched
        }
      };
    },
    forceRate(r) { return applyRate(r); }
  };

  console.log('[TEMPO Slider] page-inject loaded, AudioContext patched');
  window.postMessage({ [MSG_TAG]: true, type: 'inject-ready' }, '*');
})();
