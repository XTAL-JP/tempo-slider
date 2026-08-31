// TEMPO Slider - fx-chain.js
//
// DJM シリーズ風のエフェクトユニット（Roll を除く「易しい系」）を Web Audio ノードで構築する共有モジュール。
// content.js（直接経路）・youtube-bridge.js・bandcamp-bridge.js の 3 経路すべてから利用する。
//
// これらのコンテンツスクリプトはモジュール import できない IIFE なので、
// 各経路より先に読み込ませて分離ワールドのグローバル window.TempoSliderFX 経由でファクトリを共有する。
//
// グラフ形状はどの経路も共通:
//   source → [rubberband worklet(masterTempo)] → gainNode → destination
// この worklet/source と gainNode の間に FxChain.input → ... → FxChain.output を挿入する。
//
// 設計方針:
//   - 各エフェクトは 1 度だけ構築し、パラメータだけ差し替える（再構築でのプチノイズを避ける）。
//   - amount=0（または該当 enabled=false）のとき「完全ドライスルー（原音そのまま）」になること。
//   - BPM 同期系（Echo / Trans / Flanger）は updateBpm(bpm) で追従する。

(() => {
  'use strict';

  if (window.TempoSliderFX) return; // 二重定義防止（同一フレームに複数回注入されうる）

  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

  // エフェクト初期値。UI・各経路はこの形の plain object を state として持つ。
  function defaultParams() {
    return {
      // Color FX Filter: amount = -1(ローパス=こもる) .. 0(フラット) .. +1(ハイパス=スカスカ)
      filter:  { on: false, amount: 0 },
      // 3バンドアイソレーター（ON/OFF・カット/ブースト両方向）: 各 -1(キル=無音) .. 0(0dB) .. +1(+6dB)
      iso:     { on: false, low: 0, mid: 0, high: 0 },
      // Echo（ビート同期ディレイ）
      echo:    { on: false, division: 0.5, depth: 0.4 }, // division=拍分割(1=1拍), depth=フィードバック/wet量 0..1
      // Trans（ビート同期ゲート）
      trans:   { on: false, division: 0.5, depth: 0.9 }, // depth=切れの深さ 0..1
      // Flanger
      flanger: { on: false, division: 4,   depth: 0.5 }, // division=1周期あたりの拍数, depth=mix 0..1
      // Reverb
      reverb:  { on: false, depth: 0.35 },               // depth=wet 0..1
      // Crush（ビットクラッシュ）
      crush:   { on: false, bits: 6, depth: 0.6 },       // bits=量子化ビット数 2..12, depth=wet 0..1
      // Pitch（テンポ非依存のピッチシフト・rubberband 利用）
      pitch:   { on: false, semitones: 0 },              // -12 .. +12
    };
  }

  // 拍→秒。bpm 不明時は 120 とみなす。
  const beatSeconds = (bpm) => 60 / (bpm && bpm > 0 ? bpm : 120);

  class FxChain {
    // ctx: AudioContext
    // opts.rubberbandReady: rubberband-processor が addModule 済みなら true（Pitch 用）
    constructor(ctx, opts = {}) {
      this.ctx = ctx;
      this.bpm = null;
      this.params = defaultParams();
      this.rubberbandReady = !!opts.rubberbandReady;

      const t = ctx.currentTime;

      // --- 直列チェーンの端点 ---
      this.input  = ctx.createGain();
      this.output = ctx.createGain();

      // ---------- Filter (Color FX) ----------
      // 単一 Biquad。amount の符号でローパス/ハイパスを切り替える。0 で実質バイパス。
      this._filter = ctx.createBiquadFilter();
      this._filter.type = 'lowpass';
      this._filter.frequency.setValueAtTime(22050, t);
      this._filter.Q.setValueAtTime(0.0001, t);

      // ---------- Flanger ----------
      // input → [dry] → flOut
      //       → flDelay(1〜7ms, LFO変調) → flFb → flDelay へ戻す
      //                                  → flWet → flOut
      this._flIn   = ctx.createGain();
      this._flOut  = ctx.createGain();
      this._flDry  = ctx.createGain();
      this._flDelay = ctx.createDelay(0.05);
      this._flDelay.delayTime.setValueAtTime(0.003, t);
      this._flFb   = ctx.createGain(); this._flFb.gain.setValueAtTime(0, t);
      this._flWet  = ctx.createGain(); this._flWet.gain.setValueAtTime(0, t);
      this._flLfo  = ctx.createOscillator(); this._flLfo.type = 'sine';
      this._flLfoGain = ctx.createGain(); this._flLfoGain.gain.setValueAtTime(0.002, t); // 変調深さ(秒)
      this._flLfo.frequency.setValueAtTime(0.25, t);
      this._flLfo.connect(this._flLfoGain).connect(this._flDelay.delayTime);
      this._flDry.gain.setValueAtTime(1, t);
      this._flIn.connect(this._flDry).connect(this._flOut);
      this._flIn.connect(this._flDelay);
      this._flDelay.connect(this._flFb).connect(this._flDelay);
      this._flDelay.connect(this._flWet).connect(this._flOut);
      try { this._flLfo.start(); } catch {}

      // ---------- Echo (beat-synced delay) ----------
      // ecIn → [dry] → ecOut
      //      → ecDelay → ecFb → ecDelay へ戻す
      //                → ecWet → ecOut
      this._ecIn   = ctx.createGain();
      this._ecOut  = ctx.createGain();
      this._ecDry  = ctx.createGain(); this._ecDry.gain.setValueAtTime(1, t);
      this._ecDelay = ctx.createDelay(4.0);
      this._ecDelay.delayTime.setValueAtTime(0.25, t);
      this._ecFb   = ctx.createGain(); this._ecFb.gain.setValueAtTime(0, t);
      this._ecWet  = ctx.createGain(); this._ecWet.gain.setValueAtTime(0, t);
      // フィードバックにわずかなローパスを噛ませて DJM の Echo らしい減衰にする
      this._ecFbLp = ctx.createBiquadFilter();
      this._ecFbLp.type = 'lowpass';
      this._ecFbLp.frequency.setValueAtTime(6000, t);
      // 送り(send): エフェクトへの入力ゲート。off 時はここを 0 にして新規入力だけ止め、
      // wet/feedback は開けたままにするとディレイライン内の残響が自然に減衰＝テールが残る。
      this._ecSend = ctx.createGain(); this._ecSend.gain.setValueAtTime(0, t);
      this._ecIn.connect(this._ecDry).connect(this._ecOut);
      this._ecIn.connect(this._ecSend).connect(this._ecDelay);
      this._ecDelay.connect(this._ecFbLp).connect(this._ecFb).connect(this._ecDelay);
      this._ecDelay.connect(this._ecWet).connect(this._ecOut);

      // ---------- Reverb ----------
      this._rvIn   = ctx.createGain();
      this._rvOut  = ctx.createGain();
      this._rvDry  = ctx.createGain(); this._rvDry.gain.setValueAtTime(1, t);
      this._rvWet  = ctx.createGain(); this._rvWet.gain.setValueAtTime(0, t);
      this._rvConv = ctx.createConvolver();
      this._rvConv.buffer = this._makeImpulse(2.2, 2.5);
      // 送り(send): off 時はここを 0 にして新規入力を止める。wet は開けたままなので
      // コンボルバーが IR 長ぶんの残響を鳴らし切る＝テールが残る。
      this._rvSend = ctx.createGain(); this._rvSend.gain.setValueAtTime(0, t);
      this._rvIn.connect(this._rvDry).connect(this._rvOut);
      this._rvIn.connect(this._rvSend).connect(this._rvConv).connect(this._rvWet).connect(this._rvOut);

      // ---------- Crush (bitcrush) ----------
      this._crIn   = ctx.createGain();
      this._crOut  = ctx.createGain();
      this._crDry  = ctx.createGain(); this._crDry.gain.setValueAtTime(1, t);
      this._crWet  = ctx.createGain(); this._crWet.gain.setValueAtTime(0, t);
      this._crShaper = ctx.createWaveShaper();
      this._crShaper.curve = this._makeCrushCurve(6);
      this._crShaper.oversample = 'none';
      this._crIn.connect(this._crDry).connect(this._crOut);
      this._crIn.connect(this._crShaper).connect(this._crWet).connect(this._crOut);

      // ---------- Trans (beat-synced gate) ----------
      // 矩形 LFO で gain を 0..1 に切る。amount=0（on=false）では gain 一定 1。
      this._trGate = ctx.createGain();
      // 重要: gain の基準値は 0 にする。AudioParam の実効値は「基準値 + 接続入力の合計」なので、
      // 基準値を 1 にすると bias(1) と足されて gain=2（＝全信号が +6dB）になってしまう。
      // 基準を 0 にし、定常分は bias ConstantSource(offset 1) だけで与える。
      this._trGate.gain.setValueAtTime(0, t);
      this._trLfo  = ctx.createOscillator(); this._trLfo.type = 'square';
      this._trLfo.frequency.setValueAtTime(2, t);
      this._trDepth = ctx.createGain(); this._trDepth.gain.setValueAtTime(0, t); // 変調深さ 0=ゲート無効
      this._trBias  = ctx.createConstantSource(); this._trBias.offset.setValueAtTime(1, t);
      // gate.gain = 0(基準) + bias(1) + lfo(±1)*depth。depth=0.5 で 1±0.5、depth を上げるほど深く切れる。
      this._trBias.connect(this._trGate.gain);
      this._trLfo.connect(this._trDepth).connect(this._trGate.gain);
      try { this._trLfo.start(); } catch {}
      try { this._trBias.start(); } catch {}

      // ---------- Isolator (3-band, 直列シェルフ/ピーキング EQ) ----------
      // low(ローシェルフ) → mid(ピーキング) → high(ハイシェルフ) を直列につなぐ。
      // 全バンド 0dB のとき各フィルタは素通し＝入力そのままになり、ON にしても音量が変わらない
      // （並列分割＋合算方式はバンド再構成で音量が持ち上がる問題があったため、直列 EQ 方式に変更）。
      // kill はシェルフ/ピークを大きく下げて実現（完全なブリックウォールではないが DJ 用途には十分）。
      this._isoLow  = ctx.createBiquadFilter(); this._isoLow.type  = 'lowshelf';  this._isoLow.frequency.setValueAtTime(200, t);
      this._isoMid  = ctx.createBiquadFilter(); this._isoMid.type  = 'peaking';   this._isoMid.frequency.setValueAtTime(1000, t); this._isoMid.Q.setValueAtTime(0.8, t);
      this._isoHigh = ctx.createBiquadFilter(); this._isoHigh.type = 'highshelf'; this._isoHigh.frequency.setValueAtTime(4000, t);
      this._isoLow.connect(this._isoMid).connect(this._isoHigh);
      // 直列チェーンの入口/出口として扱う
      this._isoIn  = this._isoLow;
      this._isoOut = this._isoHigh;

      // ---------- Pitch (rubberband, optional) ----------
      // ノードは setParams で必要時に生成する（未使用時は挿入しない）。
      this._pitchNode = null;
      this._pitchInserted = false;

      // --- 直列に結線 ---
      // input → iso → filter → flanger → echo → reverb → crush → trans → (pitch) → output
      // アイソレーターは最前段（音作りの土台）に置く。
      this.input.connect(this._isoIn);
      this._isoOut.connect(this._filter);
      this._filter.connect(this._flIn);
      this._flOut.connect(this._ecIn);
      this._ecOut.connect(this._rvIn);
      this._rvOut.connect(this._crIn);
      this._crOut.connect(this._trGate);
      // trGate → output（pitch が入る場合は setParams で差し替え）
      this._trGate.connect(this.output);

      this.setParams(this.params, this.bpm);
    }

    // 減衰インパルス応答（アルゴリズミック・リバーブ）
    _makeImpulse(seconds, decay) {
      const rate = this.ctx.sampleRate;
      const len = Math.max(1, Math.floor(seconds * rate));
      const buf = this.ctx.createBuffer(2, len, rate);
      for (let ch = 0; ch < 2; ch++) {
        const d = buf.getChannelData(ch);
        for (let i = 0; i < len; i++) {
          // ホワイトノイズ × 指数減衰。乱数は Math.random ではなく決定的な擬似乱数でもよいが
          // リバーブのテールなので通常の乱数で十分。
          d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
        }
      }
      return buf;
    }

    // ビットクラッシュ用の量子化カーブ
    _makeCrushCurve(bits) {
      const steps = Math.pow(2, clamp(bits, 1, 16));
      const n = 4096;
      const curve = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * 2 - 1;           // -1..1
        curve[i] = Math.round(x * (steps / 2)) / (steps / 2); // 量子化
      }
      return curve;
    }

    updateBpm(bpm) {
      this.bpm = bpm;
      this._applyBeatSync();
    }

    _applyBeatSync() {
      const t = this.ctx.currentTime;
      const beat = beatSeconds(this.bpm);
      const p = this.params;
      // Echo: delayTime = 拍長 × division
      const ecTime = clamp(beat * p.echo.division, 0.001, 4.0);
      this._ecDelay.delayTime.setTargetAtTime(ecTime, t, 0.01);
      // Trans: 周波数 = 1拍あたりの切り = (1/beat) × (1/division)
      const trHz = clamp((1 / beat) / p.trans.division, 0.1, 40);
      this._trLfo.frequency.setTargetAtTime(trHz, t, 0.01);
      // Flanger: LFO 周波数 = (1/beat) / division拍
      const flHz = clamp((1 / beat) / p.flanger.division, 0.02, 8);
      this._flLfo.frequency.setTargetAtTime(flHz, t, 0.02);
    }

    // params: defaultParams() 形の plain object
    setParams(params, bpm) {
      this.params = Object.assign(defaultParams(), params || {});
      if (typeof bpm === 'number') this.bpm = bpm;
      const ctx = this.ctx;
      const t = ctx.currentTime;
      const p = this.params;

      // ---- Filter ----
      // off または amount≒0 のときはバイパス。on のときだけ amount を反映する。
      const f = p.filter.on ? clamp(p.filter.amount, -1, 1) : 0;
      if (Math.abs(f) < 0.02) {
        // バイパス: ローパスを可聴域上限へ、Q を最小に
        this._filter.type = 'lowpass';
        this._filter.frequency.setTargetAtTime(22050, t, 0.02);
        this._filter.Q.setTargetAtTime(0.0001, t, 0.02);
      } else if (f < 0) {
        // ローパス: 22kHz → 200Hz（対数）
        const norm = -f; // 0..1
        const freq = Math.exp(Math.log(22050) + norm * (Math.log(200) - Math.log(22050)));
        this._filter.type = 'lowpass';
        this._filter.frequency.setTargetAtTime(freq, t, 0.02);
        this._filter.Q.setTargetAtTime(1 + norm * 4, t, 0.02);
      } else {
        // ハイパス: 20Hz → 8kHz（対数）
        const norm = f;
        const freq = Math.exp(Math.log(20) + norm * (Math.log(8000) - Math.log(20)));
        this._filter.type = 'highpass';
        this._filter.frequency.setTargetAtTime(freq, t, 0.02);
        this._filter.Q.setTargetAtTime(1 + norm * 4, t, 0.02);
      }

      // ---- Isolator（ON/OFF・カット/ブースト両方向）----
      // ノブ中央(0)=0dB(素通し)、下げると -40dB(≒キル)まで、上げると +6dB までブースト。
      // OFF のときは全バンド 0dB に戻し完全バイパスにする
      // （ツマミ位置を保持したまま原音へ戻せる＝DJM のアイソレーター ON/OFF 挙動）。
      const ISO_CUT_DB = 40;   // 下げ方向: -1 で -40dB（ほぼキル）
      const ISO_BOOST_DB = 6;  // 上げ方向: +1 で +6dB（DJM 実機準拠）
      const isoDb = (k) => {
        if (!p.iso.on) return 0;
        const v = clamp(k, -1, 1);
        return v >= 0 ? v * ISO_BOOST_DB : v * ISO_CUT_DB;
      };
      this._isoLow.gain.setTargetAtTime(isoDb(p.iso.low), t, 0.02);
      this._isoMid.gain.setTargetAtTime(isoDb(p.iso.mid), t, 0.02);
      this._isoHigh.gain.setTargetAtTime(isoDb(p.iso.high), t, 0.02);

      // ---- Echo ----
      // wet/feedback は常に depth 準拠にしておき、on/off は送り(send)で切り替える。
      // off にすると新規入力だけ止まり、ディレイ内の残響がフィードバックで減衰しながら
      // 鳴り続ける＝テールが残る（DJM で Echo を切ると残響が後ろに流れる挙動）。
      {
        // ドライは常に素通し。ウェット/フィードバックは控えめにして ON 時の音量増を抑える。
        const d = clamp(p.echo.depth, 0, 1);
        this._ecWet.gain.setTargetAtTime(d * 0.6, t, 0.02);
        this._ecFb.gain.setTargetAtTime(clamp(d * 0.6, 0, 0.85), t, 0.02); // 発振防止で上限
        this._ecSend.gain.setTargetAtTime(p.echo.on ? 1 : 0, t, 0.01);
      }

      // ---- Trans (gate) ----
      // depth: 0=無効, 1=フルに 0 まで切る。gain 変調深さ = depth/2（bias=1 と合わせて 1±depth/2、
      // depth=1 のとき谷が 0.5 になるので、より深く切るため最大 1.0 まで許容）
      if (p.trans.on) {
        this._trDepth.gain.setTargetAtTime(clamp(p.trans.depth, 0, 1), t, 0.01);
      } else {
        this._trDepth.gain.setTargetAtTime(0, t, 0.01);
      }

      // ---- Flanger ----
      // dry/wet を按分（dry=1-0.5d, wet=0.5d）して ON 時の音量増を抑える。
      if (p.flanger.on) {
        const d = clamp(p.flanger.depth, 0, 1);
        this._flDry.gain.setTargetAtTime(1 - 0.5 * d, t, 0.02);
        this._flWet.gain.setTargetAtTime(0.5 * d, t, 0.02);
        this._flFb.gain.setTargetAtTime(clamp(d * 0.4, 0, 0.8), t, 0.02);
        this._flLfoGain.gain.setTargetAtTime(0.001 + d * 0.003, t, 0.02);
      } else {
        this._flDry.gain.setTargetAtTime(1, t, 0.02);
        this._flWet.gain.setTargetAtTime(0, t, 0.02);
        this._flFb.gain.setTargetAtTime(0, t, 0.02);
      }

      // ---- Reverb ----
      // wet は常に depth 準拠、on/off は送り(send)で切り替え、off でもコンボルバーの
      // テールが鳴り切る。
      this._rvWet.gain.setTargetAtTime(clamp(p.reverb.depth, 0, 1), t, 0.03);
      this._rvSend.gain.setTargetAtTime(p.reverb.on ? 1 : 0, t, 0.01);

      // ---- Crush ----
      if (p.crush.on) {
        this._crShaper.curve = this._makeCrushCurve(Math.round(clamp(p.crush.bits, 2, 12)));
        this._crWet.gain.setTargetAtTime(clamp(p.crush.depth, 0, 1), t, 0.02);
        this._crDry.gain.setTargetAtTime(1 - clamp(p.crush.depth, 0, 1), t, 0.02);
      } else {
        this._crWet.gain.setTargetAtTime(0, t, 0.02);
        this._crDry.gain.setTargetAtTime(1, t, 0.02);
      }

      // ---- Pitch ----
      this._applyPitch(p.pitch);

      // BPM 同期パラメータ
      this._applyBeatSync();
    }

    _applyPitch(pitch) {
      const wantOn = !!(pitch && pitch.on && Math.abs(pitch.semitones) > 0.01 && this.rubberbandReady);
      if (wantOn && !this._pitchInserted) {
        // trGate → output を trGate → pitch → output に差し替え
        try {
          this._pitchNode = new AudioWorkletNode(this.ctx, 'rubberband-processor');
          this._pitchNode.port.postMessage(JSON.stringify(['quality', true]));
          this._pitchNode.port.postMessage(JSON.stringify(['tempo', 1]));
          try { this._trGate.disconnect(this.output); } catch {}
          this._trGate.connect(this._pitchNode);
          this._pitchNode.connect(this.output);
          this._pitchInserted = true;
        } catch (e) {
          console.warn('[TEMPO Slider FX] pitch node create failed:', e);
          this._pitchNode = null;
        }
      }
      if (this._pitchInserted && this._pitchNode) {
        if (wantOn) {
          const ratio = Math.pow(2, clamp(pitch.semitones, -12, 12) / 12);
          this._pitchNode.port.postMessage(JSON.stringify(['pitch', ratio]));
        } else {
          // ピッチ 1.0（バイパス相当）。ノードは残す（抜き差しのプチノイズ回避）。
          this._pitchNode.port.postMessage(JSON.stringify(['pitch', 1]));
        }
      }
    }

    // チェーン全体を破棄（グラフ再構築時に呼ぶ）
    dispose() {
      try { this._flLfo.stop(); } catch {}
      try { this._trLfo.stop(); } catch {}
      try { this._trBias.stop(); } catch {}
      const nodes = [
        this.input, this.output, this._filter,
        this._flIn, this._flOut, this._flDry, this._flDelay, this._flFb, this._flWet, this._flLfo, this._flLfoGain,
        this._ecIn, this._ecOut, this._ecDry, this._ecSend, this._ecDelay, this._ecFb, this._ecWet, this._ecFbLp,
        this._rvIn, this._rvOut, this._rvDry, this._rvSend, this._rvWet, this._rvConv,
        this._crIn, this._crOut, this._crDry, this._crWet, this._crShaper,
        this._trGate, this._trLfo, this._trDepth, this._trBias,
        this._isoLow, this._isoMid, this._isoHigh,
        this._pitchNode,
      ];
      for (const n of nodes) { try { n && n.disconnect(); } catch {} }
    }
  }

  window.TempoSliderFX = {
    create(ctx, opts) { return new FxChain(ctx, opts); },
    defaultParams,
  };
})();
