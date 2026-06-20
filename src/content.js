// BPM Changer - content script
// CDJ 風の UI で BandCamp の <audio> のテンポをコントロール

(() => {
  'use strict';

  const ext = (typeof browser !== 'undefined') ? browser : chrome;

  const state = {
    audioCtx: null,
    sourceNode: null,
    workletNode: null,
    gainNode: null,
    workletLoaded: false,
    hookedElement: null,
    graphedElement: null,
    masterTempo: false,          // MASTER TEMPO（ピッチキープ）
    tempoOffset: 0,              // テンポオフセット (%)、フェーダー値
    tempoRange: 10,              // フェーダー可変域 ±N%
    tempoRatio: 1.0,             // = 1 + tempoOffset/100
    originalBpm: null,
    tapTimes: [],
    bpmDetector: null,
  };

  function findAudioElement() {
    return document.querySelector('audio');
  }

  function attachLightweight(audioEl) {
    if (state.hookedElement === audioEl) return;
    // SoundTouchJS が動作する条件: ブラウザ側のピッチ保持を OFF
    // （CDJ 非 MASTER TEMPO モードでも速度と一緒にピッチが動く挙動になり、CDJ 仕様に合う）
    try { audioEl.preservesPitch = false; } catch {}
    state.hookedElement = audioEl;
    applyTempo();
  }

  // ============================================================
  // Web Audio グラフ（MASTER TEMPO ON or BPM 自動検知 時に構築）
  // ============================================================
  async function ensureGraph() {
    if (!state.hookedElement) return false;
    if (state.graphedElement === state.hookedElement) return true;

    if (!state.audioCtx) {
      state.audioCtx = new AudioContext();
    }

    if (!state.workletLoaded) {
      try {
        await state.audioCtx.audioWorklet.addModule(ext.runtime.getURL('rubberband-worklet.js'));
        state.workletLoaded = true;
      } catch (e) {
        console.warn('[TEMPO Slider] worklet ロード失敗:', e);
      }
    }

    try {
      if (!state.hookedElement.crossOrigin) {
        const wasPlaying = !state.hookedElement.paused;
        const currentTime = state.hookedElement.currentTime;
        state.hookedElement.crossOrigin = 'anonymous';
        state.hookedElement.load();
        state.hookedElement.currentTime = currentTime;
        if (wasPlaying) state.hookedElement.play().catch(() => {});
      }
      // SoundTouchJS が動作する条件: ブラウザ側のピッチ保持を OFF
      try { state.hookedElement.preservesPitch = false; } catch {}
      state.sourceNode = state.audioCtx.createMediaElementSource(state.hookedElement);
      state.gainNode = state.audioCtx.createGain();
      state.graphedElement = state.hookedElement;
      rebuildGraph();
      return true;
    } catch (e) {
      console.error('[BPM Changer] グラフ構築失敗:', e);
      return false;
    }
  }

  function rebuildGraph() {
    if (!state.sourceNode) return;

    try { state.sourceNode.disconnect(); } catch {}
    try { state.gainNode.disconnect(); } catch {}
    if (state.workletNode) {
      try { state.workletNode.disconnect(); } catch {}
      state.workletNode = null;
    }

    state.gainNode.gain.setValueAtTime(1.0, state.audioCtx.currentTime);

    if (state.masterTempo && state.workletLoaded) {
      try {
        state.workletNode = new AudioWorkletNode(state.audioCtx, 'rubberband-processor');
        // Rubber Band API: port.postMessage で JSON コマンドを送る
        //   ['pitch', value]   ピッチ倍率
        //   ['tempo', value]   タイムストレッチ倍率（本拡張では使わない）
        //   ['quality', bool]  高品質モード
        //
        // アーキテクチャ:
        //   audio.playbackRate = tempoRatio  (要素側で速度＋ピッチが上下)
        //   worklet.setPitch(1/tempoRatio)   (ピッチを逆方向に補正)
        state.workletNode.port.postMessage(JSON.stringify(['quality', true]));
        state.workletNode.port.postMessage(JSON.stringify(['pitch', 1 / state.tempoRatio]));

        state.sourceNode.connect(state.workletNode);
        state.workletNode.connect(state.gainNode);
      } catch (e) {
        console.warn('[TEMPO Slider] worklet ノード作成失敗:', e);
        state.sourceNode.connect(state.gainNode);
      }
    } else {
      state.sourceNode.connect(state.gainNode);
    }
    state.gainNode.connect(state.audioCtx.destination);

    if (state.bpmDetector) state.bpmDetector.reconnect(state.sourceNode);
  }

  function applyTempo() {
    state.tempoRatio = 1 + state.tempoOffset / 100;
    if (state.hookedElement) {
      state.hookedElement.playbackRate = state.tempoRatio;
    }
    if (state.masterTempo && state.workletNode) {
      // Rubber Band の pitch を audio.playbackRate の逆数に設定してピッチを元に戻す
      state.workletNode.port.postMessage(JSON.stringify(['pitch', 1 / state.tempoRatio]));
    }
    updateTempoDisplay();
    updateCurrentBpmDisplay();
    if (panelRefs && panelRefs.updateFaderThumb) {
      panelRefs.updateFaderThumb();
    }
  }

  async function setMasterTempo(on) {
    if (on === state.masterTempo) return true;
    if (on) {
      const ok = await ensureGraph();
      if (!ok) return false;
      state.masterTempo = true;
      rebuildGraph();
    } else {
      state.masterTempo = false;
      if (state.sourceNode) rebuildGraph();
    }
    applyTempo();
    return true;
  }

  // ============================================================
  // BPM 検知器
  // ============================================================
  class BpmDetector {
    constructor(audioCtx, onDone) {
      this.audioCtx = audioCtx;
      this.onDone = onDone;
      this.lowpass = audioCtx.createBiquadFilter();
      this.lowpass.type = 'lowpass';
      this.lowpass.frequency.value = 150;
      this.analyser = audioCtx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0;
      this.lowpass.connect(this.analyser);
      this.buf = new Float32Array(this.analyser.fftSize);
      this.energyHist = [];
      this.peakTimes = [];
      this.intervalId = null;
      this.timeoutId = null;
    }

    reconnect(source) {
      try { source.connect(this.lowpass); } catch {}
    }

    start(source, durationMs = 12000) {
      this.reconnect(source);
      this.peakTimes = [];
      this.energyHist = [];
      this.intervalId = setInterval(() => this.tick(), 30);
      this.timeoutId = setTimeout(() => this.stop(), durationMs);
    }

    stop() {
      if (this.intervalId) { clearInterval(this.intervalId); this.intervalId = null; }
      if (this.timeoutId) { clearTimeout(this.timeoutId); this.timeoutId = null; }
      try { this.lowpass.disconnect(); } catch {}
      if (this.onDone) this.onDone(this.estimate());
    }

    tick() {
      this.analyser.getFloatTimeDomainData(this.buf);
      let sum = 0;
      for (let i = 0; i < this.buf.length; i++) sum += this.buf[i] * this.buf[i];
      const energy = Math.sqrt(sum / this.buf.length);
      this.energyHist.push(energy);
      if (this.energyHist.length > 33) this.energyHist.shift();
      if (this.energyHist.length < 10) return;
      const avg = this.energyHist.reduce((s, x) => s + x, 0) / this.energyHist.length;
      const now = performance.now();
      const lastPeak = this.peakTimes[this.peakTimes.length - 1];
      if (energy > avg * 1.4 && energy > 0.005 && (!lastPeak || now - lastPeak > 200)) {
        this.peakTimes.push(now);
        if (this.peakTimes.length > 80) this.peakTimes.shift();
      }
    }

    estimate() {
      if (this.peakTimes.length < 8) return null;
      const intervals = [];
      for (let i = 1; i < this.peakTimes.length; i++) {
        const dt = this.peakTimes[i] - this.peakTimes[i - 1];
        if (dt > 300 && dt < 1500) intervals.push(dt);
      }
      if (intervals.length < 6) return null;
      intervals.sort((a, b) => a - b);
      const median = intervals[Math.floor(intervals.length / 2)];
      let bpm = 60000 / median;
      while (bpm < 70) bpm *= 2;
      while (bpm > 180) bpm /= 2;
      return Math.round(bpm);
    }
  }

  // ============================================================
  // タップテンポ
  // ============================================================
  function onTap() {
    const now = performance.now();
    if (state.tapTimes.length && now - state.tapTimes[state.tapTimes.length - 1] > 2000) {
      state.tapTimes = [];
    }
    state.tapTimes.push(now);
    if (state.tapTimes.length > 8) state.tapTimes.shift();
    if (state.tapTimes.length < 2) return null;
    let total = 0;
    for (let i = 1; i < state.tapTimes.length; i++) {
      total += state.tapTimes[i] - state.tapTimes[i - 1];
    }
    return Math.round(60000 / (total / (state.tapTimes.length - 1)));
  }

  function watchAudioChanges() {
    const observer = new MutationObserver(() => {
      const el = findAudioElement();
      if (el && el !== state.hookedElement) attachLightweight(el);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const el = findAudioElement();
    if (el) attachLightweight(el);
  }

  // ============================================================
  // UI
  // ============================================================
  let panelRefs = null;

  function formatTempo(offset) {
    const sign = offset > 0 ? '+' : (offset < 0 ? '−' : '');
    return `${sign}${Math.abs(offset).toFixed(1)}%`;
  }

  function updateTempoDisplay() {
    if (!panelRefs) return;
    const isZero = Math.abs(state.tempoOffset) < 0.05;
    panelRefs.tempoVal.textContent = formatTempo(state.tempoOffset);
    panelRefs.tempoVal.classList.toggle('is-zero', isZero);
    if (panelRefs.centerLed) {
      panelRefs.centerLed.classList.toggle('is-on', isZero);
    }
  }

  function updateCurrentBpmDisplay() {
    if (!panelRefs) return;
    if (state.originalBpm) {
      const current = (state.originalBpm * state.tempoRatio).toFixed(1);
      panelRefs.currentValue.textContent = current;
    } else {
      panelRefs.currentValue.textContent = '--';
    }
  }

  function setOriginalBpm(bpm) {
    state.originalBpm = bpm;
    if (panelRefs && bpm) panelRefs.originalInput.value = String(bpm);
    updateCurrentBpmDisplay();
  }

  function adjustTempo(delta) {
    let next = state.tempoOffset + delta;
    next = Math.max(-state.tempoRange, Math.min(state.tempoRange, next));
    next = Math.round(next * 10) / 10;
    state.tempoOffset = next;
    applyTempo();
  }

  function resetTempo() {
    state.tempoOffset = 0;
    applyTempo();
  }

  function setRange(range) {
    state.tempoRange = range;
    if (!panelRefs) return;
    // 現在値がレンジ外なら丸める
    if (Math.abs(state.tempoOffset) > range) {
      state.tempoOffset = Math.sign(state.tempoOffset) * range;
    }
    applyTempo();
    panelRefs.rangeButtons.forEach((b) => {
      b.classList.toggle('is-active', parseInt(b.dataset.range, 10) === range);
    });
  }

  function injectPanel() {
    if (document.getElementById('tempo-slider-panel')) return;

    const panel = document.createElement('div');
    panel.id = 'tempo-slider-panel';
    panel.innerHTML = `
      <div class="tempo-slider__header">
        <span class="tempo-slider__title">TEMPO Slider</span>
        <button class="tempo-slider__toggle" type="button" aria-label="Collapse">−</button>
      </div>
      <div class="tempo-slider__body">
        <div class="tempo-slider__main">
          <div class="tempo-slider__col tempo-slider__col--fader">
            <div class="tempo-slider__range">
              <button data-range="6" class="tempo-slider__range-btn">±6</button>
              <button data-range="10" class="tempo-slider__range-btn">±10</button>
              <button data-range="16" class="tempo-slider__range-btn">±16</button>
              <button data-range="50" class="tempo-slider__range-btn">WIDE</button>
            </div>
            <div class="tempo-slider__fader-area">
              <div class="tempo-slider__fader-marks">
                <span class="tempo-slider__mark">−</span>
                <span class="tempo-slider__mark tempo-slider__mark--center">
                  <span class="tempo-slider__center-led"></span>
                  <span>0</span>
                </span>
                <span class="tempo-slider__mark">+</span>
              </div>
              <div class="tempo-slider__fader-track">
                <div class="tempo-slider__fader-rail"></div>
                <div class="tempo-slider__fader-thumb"></div>
              </div>
            </div>
            <button class="tempo-slider__reset" type="button" title="Reset (R)">TEMPO RESET</button>
          </div>
          <div class="tempo-slider__col tempo-slider__col--info">
            <div class="tempo-slider__tempo-val is-zero">0.0%</div>
            <button class="tempo-slider__master-tempo" type="button" title="Toggle pitch keep (M)">
              <span class="tempo-slider__led"></span>
              MASTER TEMPO
            </button>
            <div class="tempo-slider__bpm-block">
              <div class="tempo-slider__bpm-row">
                <span class="tempo-slider__label">Original</span>
                <input type="number" class="tempo-slider__original" min="40" max="240" placeholder="--" />
                <span class="tempo-slider__unit">BPM</span>
              </div>
              <div class="tempo-slider__bpm-actions">
                <button type="button" class="tempo-slider__tap" title="Tap tempo (T)">TAP</button>
                <button type="button" class="tempo-slider__detect">AUTO</button>
              </div>
              <div class="tempo-slider__bpm-row tempo-slider__bpm-row--current">
                <span class="tempo-slider__label">Current</span>
                <span class="tempo-slider__current-value">--</span>
                <span class="tempo-slider__unit">BPM</span>
              </div>
            </div>
            <div class="tempo-slider__status"></div>
            <div class="tempo-slider__shortcuts" title="Keyboard shortcuts">
              <kbd>,</kbd><kbd>.</kbd> adjust (Shift = coarse)<br>
              <kbd>R</kbd> reset / <kbd>M</kbd> master / <kbd>T</kbd> tap / wheel
            </div>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(panel);

    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = ext.runtime.getURL('panel.css');
    document.head.appendChild(link);

    bindPanelEvents(panel);
  }

  // ============================================================
  // パネルドラッグ（ヘッダーで掴んで移動・位置記憶）
  // ============================================================
  function setupPanelDrag(panel) {
    const header = panel.querySelector('.tempo-slider__header');
    const STORAGE_KEY = 'tempoSliderPanelPosition';

    function applyPosition(top, left) {
      // ビューポート内に制約
      const rect = panel.getBoundingClientRect();
      const maxTop = Math.max(0, window.innerHeight - rect.height);
      const maxLeft = Math.max(0, window.innerWidth - rect.width);
      const clampedTop = Math.max(0, Math.min(maxTop, top));
      const clampedLeft = Math.max(0, Math.min(maxLeft, left));
      panel.style.top = `${clampedTop}px`;
      panel.style.left = `${clampedLeft}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    }

    function savePosition() {
      const rect = panel.getBoundingClientRect();
      try {
        ext.storage.local.set({ [STORAGE_KEY]: { top: rect.top, left: rect.left } });
      } catch (e) {
        console.warn('[TEMPO Slider] 位置保存失敗:', e);
      }
    }

    // 保存された位置を復元
    try {
      ext.storage.local.get([STORAGE_KEY], (result) => {
        const pos = result && result[STORAGE_KEY];
        if (pos && typeof pos.top === 'number' && typeof pos.left === 'number') {
          applyPosition(pos.top, pos.left);
        }
      });
    } catch (e) {
      console.warn('[TEMPO Slider] 位置復元失敗:', e);
    }

    let dragging = false;
    let startX = 0, startY = 0, initialTop = 0, initialLeft = 0;

    header.addEventListener('pointerdown', (e) => {
      // ヘッダー内のボタン（折りたたみ等）はドラッグ対象外
      if (e.target.closest('button')) return;
      e.preventDefault();
      dragging = true;
      const rect = panel.getBoundingClientRect();
      initialTop = rect.top;
      initialLeft = rect.left;
      startX = e.clientX;
      startY = e.clientY;
      header.setPointerCapture(e.pointerId);
      header.classList.add('is-dragging');
    });

    header.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      applyPosition(initialTop + (e.clientY - startY), initialLeft + (e.clientX - startX));
    });

    header.addEventListener('pointerup', (e) => {
      if (!dragging) return;
      dragging = false;
      try { header.releasePointerCapture(e.pointerId); } catch {}
      header.classList.remove('is-dragging');
      savePosition();
    });

    // ウィンドウリサイズ時にビューポート外に出ないように再制約
    window.addEventListener('resize', () => {
      if (panel.style.top) {
        const rect = panel.getBoundingClientRect();
        applyPosition(rect.top, rect.left);
      }
    });
  }

  function bindPanelEvents(panel) {
    const faderTrack = panel.querySelector('.tempo-slider__fader-track');
    const faderThumb = panel.querySelector('.tempo-slider__fader-thumb');
    const tempoVal = panel.querySelector('.tempo-slider__tempo-val');
    const masterBtn = panel.querySelector('.tempo-slider__master-tempo');
    const resetBtn = panel.querySelector('.tempo-slider__reset');
    const toggleBtn = panel.querySelector('.tempo-slider__toggle');
    const body = panel.querySelector('.tempo-slider__body');
    const statusEl = panel.querySelector('.tempo-slider__status');
    const originalInput = panel.querySelector('.tempo-slider__original');
    const currentValue = panel.querySelector('.tempo-slider__current-value');
    const tapBtn = panel.querySelector('.tempo-slider__tap');
    const detectBtn = panel.querySelector('.tempo-slider__detect');
    const rangeButtons = Array.from(panel.querySelectorAll('.tempo-slider__range-btn'));
    const centerLed = panel.querySelector('.tempo-slider__center-led');

    // カスタムフェーダー（divベース）のセットアップ
    const FADER_PADDING = 14; // 上下の余白（thumb 半分くらい）

    function updateFaderThumb() {
      const rect = faderTrack.getBoundingClientRect();
      const usable = rect.height - 2 * FADER_PADDING;
      if (usable <= 0) return;
      const norm = (state.tempoOffset + state.tempoRange) / (2 * state.tempoRange);
      const y = FADER_PADDING + norm * usable;
      faderThumb.style.top = `${y}px`;
    }

    function yToTempoOffset(y) {
      const rect = faderTrack.getBoundingClientRect();
      const usable = rect.height - 2 * FADER_PADDING;
      if (usable <= 0) return state.tempoOffset;
      const clamped = Math.max(0, Math.min(usable, y - FADER_PADDING));
      const norm = clamped / usable;
      let offset = norm * 2 * state.tempoRange - state.tempoRange;
      offset = Math.round(offset * 10) / 10;
      return Math.max(-state.tempoRange, Math.min(state.tempoRange, offset));
    }

    let dragging = false;
    faderThumb.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      dragging = true;
      faderThumb.setPointerCapture(e.pointerId);
    });
    faderThumb.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const rect = faderTrack.getBoundingClientRect();
      state.tempoOffset = yToTempoOffset(e.clientY - rect.top);
      applyTempo();
    });
    faderThumb.addEventListener('pointerup', (e) => {
      dragging = false;
      try { faderThumb.releasePointerCapture(e.pointerId); } catch {}
    });

    // トラッククリックでジャンプ
    faderTrack.addEventListener('click', (e) => {
      if (e.target === faderThumb) return;
      const rect = faderTrack.getBoundingClientRect();
      state.tempoOffset = yToTempoOffset(e.clientY - rect.top);
      applyTempo();
    });

    // ホイール（フェーダートラック上）
    faderTrack.addEventListener('wheel', (e) => {
      e.preventDefault();
      const step = e.shiftKey ? 1.0 : 0.1;
      const delta = e.deltaY > 0 ? step : -step;
      adjustTempo(delta);
    }, { passive: false });

    // リサイズ時に thumb 位置を更新
    window.addEventListener('resize', updateFaderThumb);

    panelRefs = {
      tempoVal, originalInput, currentValue, statusEl,
      rangeButtons, centerLed, masterBtn, tapBtn,
      updateFaderThumb
    };

    setRange(10); // 初期レンジ ±10
    requestAnimationFrame(updateFaderThumb); // 初期 thumb 配置

    resetBtn.addEventListener('click', resetTempo);

    masterBtn.addEventListener('click', async () => {
      const next = !state.masterTempo;
      statusEl.textContent = next ? 'Building audio graph...' : '';
      masterBtn.disabled = true;
      const ok = await setMasterTempo(next);
      masterBtn.disabled = false;
      if (next && !ok) {
        statusEl.textContent = 'MASTER TEMPO toggle failed';
      } else {
        statusEl.textContent = '';
      }
      masterBtn.classList.toggle('is-on', state.masterTempo);
    });

    rangeButtons.forEach((b) => {
      b.addEventListener('click', () => {
        setRange(parseInt(b.dataset.range, 10));
      });
    });

    originalInput.addEventListener('input', () => {
      const v = parseInt(originalInput.value, 10);
      state.originalBpm = (v && v > 0) ? v : null;
      updateCurrentBpmDisplay();
    });

    tapBtn.addEventListener('click', () => {
      const bpm = onTap();
      if (bpm) {
        setOriginalBpm(bpm);
        statusEl.textContent = `Tap ${state.tapTimes.length}`;
      } else {
        statusEl.textContent = `Tap ${state.tapTimes.length} (need more)`;
      }
    });

    detectBtn.addEventListener('click', async () => {
      if (state.bpmDetector) return;
      statusEl.textContent = 'Preparing graph...';
      const ok = await ensureGraph();
      if (!ok) { statusEl.textContent = 'Graph build failed'; return; }

      const startTs = performance.now();
      const durationMs = 12000;
      detectBtn.disabled = true;
      statusEl.textContent = 'Detecting... 0%';

      const progressId = setInterval(() => {
        const pct = Math.min(100, Math.round((performance.now() - startTs) / durationMs * 100));
        const cur = state.bpmDetector ? state.bpmDetector.estimate() : null;
        statusEl.textContent = `Detecting... ${pct}%${cur ? ` (${cur})` : ''}`;
      }, 200);

      state.bpmDetector = new BpmDetector(state.audioCtx, (finalBpm) => {
        clearInterval(progressId);
        detectBtn.disabled = false;
        const corrected = finalBpm ? Math.round(finalBpm / state.tempoRatio) : null;
        if (corrected) {
          setOriginalBpm(corrected);
          statusEl.textContent = `Detected: ${corrected} BPM`;
        } else {
          statusEl.textContent = 'Detection failed (check playback)';
        }
        state.bpmDetector = null;
      });
      state.bpmDetector.start(state.sourceNode, durationMs);
    });

    toggleBtn.addEventListener('click', () => {
      const collapsed = body.style.display === 'none';
      body.style.display = collapsed ? '' : 'none';
      toggleBtn.textContent = collapsed ? '−' : '+';
    });

    setupPanelDrag(panel);
    updateTempoDisplay();
  }

  // キーボードショートカット
  // テキスト入力中 (input/textarea/contenteditable) は無効
  function isTyping() {
    const a = document.activeElement;
    if (!a) return false;
    const tag = a.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || a.isContentEditable;
  }

  document.addEventListener('keydown', (e) => {
    if (isTyping()) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return; // 修飾キーは Shift のみ許可

    let handled = true;
    switch (e.key) {
      case ',':
      case '<':
        adjustTempo(e.shiftKey ? -1.0 : -0.1);
        break;
      case '.':
      case '>':
        adjustTempo(e.shiftKey ? 1.0 : 0.1);
        break;
      case 'r':
      case 'R':
        resetTempo();
        break;
      case 'm':
      case 'M':
        if (panelRefs && panelRefs.masterBtn) panelRefs.masterBtn.click();
        break;
      case 't':
      case 'T':
        if (panelRefs && panelRefs.tapBtn) panelRefs.tapBtn.click();
        break;
      default:
        handled = false;
    }
    if (handled) e.preventDefault();
  });

  // 起動
  injectPanel();
  watchAudioChanges();

  document.addEventListener('click', () => {
    if (state.audioCtx && state.audioCtx.state === 'suspended') {
      state.audioCtx.resume();
    }
  }, true);
})();
