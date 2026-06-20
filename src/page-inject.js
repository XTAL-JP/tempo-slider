// TEMPO Slider - page inject (MAIN world)
//
// HTML <audio> 要素を使わず Web Audio API で直接再生するサイト（Beatport 等）に対応するため、
// ページのメインワールドに注入され、AudioContext.createBufferSource をモンキーパッチして
// 作成された AudioBufferSourceNode の playbackRate を一括制御する。
//
// content.js (ISOLATED world) とは window.postMessage で双方向通信する。

(() => {
  'use strict';

  // 多重注入を避ける
  if (window.__tempoSliderInjected) return;
  window.__tempoSliderInjected = true;

  const MSG_TAG = '__tempoSlider';
  let currentRate = 1.0;
  // ガベージコレクトのため WeakSet ではなく Set（ended で明示削除）
  const activeSources = new Set();

  function patchContext(Ctor) {
    if (!Ctor || !Ctor.prototype) return;
    const orig = Ctor.prototype.createBufferSource;
    if (!orig || orig.__tempoSliderPatched) return;
    Ctor.prototype.createBufferSource = function patchedCreateBufferSource() {
      const source = orig.apply(this, arguments);
      try {
        source.playbackRate.value = currentRate;
      } catch (e) {}
      activeSources.add(source);
      source.addEventListener('ended', () => activeSources.delete(source));
      return source;
    };
    Ctor.prototype.createBufferSource.__tempoSliderPatched = true;
  }

  // AudioContext と webkitAudioContext (Safari 旧) 両方パッチ
  patchContext(window.AudioContext);
  patchContext(window.webkitAudioContext);

  // 現在の playbackRate を全アクティブソースに適用
  function applyRate(rate) {
    currentRate = rate;
    for (const src of activeSources) {
      try {
        src.playbackRate.value = rate;
      } catch (e) {}
    }
  }

  // content.js からのメッセージ受信
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const data = e.data;
    if (!data || data[MSG_TAG] !== true) return;

    switch (data.type) {
      case 'setRate':
        if (typeof data.rate === 'number' && isFinite(data.rate)) {
          applyRate(data.rate);
        }
        break;
      case 'ping':
        window.postMessage({ [MSG_TAG]: true, type: 'pong', activeCount: activeSources.size }, '*');
        break;
    }
  });

  // 注入完了通知
  window.postMessage({ [MSG_TAG]: true, type: 'inject-ready' }, '*');
})();
