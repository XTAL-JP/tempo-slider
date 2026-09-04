// BPM Changer - content script
// CDJ 風の UI で BandCamp の <audio> のテンポをコントロール

(() => {
  'use strict';

  const ext = (typeof browser !== 'undefined') ? browser : chrome;

  // サイト種別判定
  //   bandcamp: HTML <audio> 要素経由
  //   beatport / traxsource: Web Audio 直接再生（page-inject.js 経由で制御）
  //   discogs: YouTube iframe 埋め込み（youtube-bridge.js 経由で制御）
  //   youtube: YouTube ページ自身（同一ウィンドウの youtube-bridge.js を bridge として使用）
  //   custom: ユーザーが popup から追加したサイト
  const SITE = (() => {
    const h = location.hostname;
    if (h.endsWith('beatport.com')) return 'beatport';
    if (h.endsWith('traxsource.com')) return 'traxsource';
    if (h.endsWith('bandcamp.com')) return 'bandcamp';
    if (h.endsWith('discogs.com')) return 'discogs';
    if (h === 'www.youtube.com') return 'youtube';
    return 'custom';
  })();
  // 組み込みサイトのホスト名マップ（無効化チェックに使用）
  const BUILTIN_HOST = {
    bandcamp: 'bandcamp.com',
    beatport: 'beatport.com',
    traxsource: 'traxsource.com',
    discogs: 'discogs.com',
    youtube: 'www.youtube.com',
  };
  const USES_PAGE_INJECT = (SITE === 'beatport' || SITE === 'traxsource');
  // YouTube iframe 経由のサイト
  const USES_IFRAME_BRIDGE = (SITE === 'discogs');
  // YouTube ページ自身 — 同一ウィンドウの youtube-bridge.js を bridge として使用
  const USES_SELF_BRIDGE = (SITE === 'youtube');
  // アイソレーター先行リリース用フラグ。他の FX（Filter/Echo/Reverb/Trans/Flanger/
  // Crush/Pitch）は作り込み中のため UI を一旦非公開にする（true で復活）。
  // ISOLATOR は情報カラムに常時表示され、この対象外（常に表示）。
  const SHOW_FX_UNIT = false;
  const MSG_TAG = '__tempoSlider';
  const BRIDGE_MSG_TAG = '__tempoSliderBridge';

  function postToPage(type, payload) {
    window.postMessage(Object.assign({ [MSG_TAG]: true, type }, payload || {}), '*');
  }

  const state = {
    audioCtx: null,
    sourceNode: null,
    workletNode: null,
    gainNode: null,
    workletLoaded: false,
    // 複数 <audio> 要素に対応するため Set で全要素を保持し、
    // ensureGraph / MASTER TEMPO / BPM 検知は activeElement（最後に play されたもの）を使う
    hookedElements: new Set(),
    activeElement: null,
    graphedElement: null,
    masterTempo: false,          // MASTER TEMPO（ピッチキープ）
    tempoOffset: 0,              // テンポオフセット (%)、フェーダー値
    tempoRange: 10,              // フェーダー可変域 ±N%
    tempoRatio: 1.0,             // = 1 + tempoOffset/100
    originalBpm: null,
    tapTimes: [],
    bpmDetector: null,
    // iframe bridge 用（discogs 等の YouTube 埋め込みサイト）
    bridgeIframes: new Set(),
    // FX（DJM 風エフェクトユニット）
    fxChain: null,                              // FxChain インスタンス（直接経路）
    fx: (window.TempoSliderFX && window.TempoSliderFX.defaultParams()) || null,
  };

  function findAudioElements() {
    return Array.from(document.querySelectorAll('audio'));
  }

  // ============================================================
  // iframe bridge（YouTube / Bandcamp 等の埋め込みプレーヤー）
  // ============================================================
  // bridge プロトコル対応の iframe を広く拾う:
  //   - YouTube (youtube.com / youtube-nocookie.com): youtube-bridge.js
  //   - Bandcamp Embedded Player: bandcamp-bridge.js
  function findBridgeIframes() {
    return Array.from(document.querySelectorAll('iframe')).filter(f => {
      const s = f.src || '';
      return s.includes('youtube.com/')
          || s.includes('youtube-nocookie.com/')
          || s.includes('bandcamp.com/EmbeddedPlayer/');
    });
  }
  // 後方互換用エイリアス
  const findYoutubeIframes = findBridgeIframes;

  // bridge 宛メッセージのパース。
  // Firefox ではコンテンツスクリプトから「別オリジンの iframe（discogs → YouTube 埋め込み）」へ
  // オブジェクトのまま postMessage すると、受信側で構造化クローンが読めず取りこぼされることがある。
  // そのため bridge との送受信は必ず JSON 文字列に統一する（後方互換でオブジェクトも受理）。
  function parseBridgeMsg(data) {
    if (data == null) return null;
    if (typeof data === 'string') {
      try { return JSON.parse(data); } catch { return null; }
    }
    return data;
  }

  function postToBridge(iframe, type, payload) {
    if (!iframe || !iframe.contentWindow) return;
    try {
      iframe.contentWindow.postMessage(
        JSON.stringify(Object.assign({ [BRIDGE_MSG_TAG]: true, type }, payload || {})),
        '*'
      );
    } catch (e) {}
  }

  function trackBridgeIframe(iframe) {
    if (!iframe || state.bridgeIframes.has(iframe)) return;
    state.bridgeIframes.add(iframe);
    // 現在のテンポ / MASTER TEMPO を反映。
    // iframe 挿入直後は中の youtube-bridge.js がまだ読み込まれておらず、
    // 最初の postMessage が取りこぼされることがある（特に Firefox の別オリジン iframe）。
    // bridgeReady 通知待ちだけに頼らず、数回リトライして bridge 読込後にも確実に届くようにする。
    const push = () => {
      postToBridge(iframe, 'setRate', { rate: state.tempoRatio });
      if (state.masterTempo) {
        postToBridge(iframe, 'setMasterTempo', { on: true });
      }
      // 現在の FX 状態も反映（有効なエフェクトがある場合のみグラフ構築を促す）
      if (state.fx) postToBridge(iframe, 'setFx', { fx: state.fx, bpm: currentHeardBpm() });
    };
    push();
    for (const ms of [150, 500, 1200, 2500]) setTimeout(push, ms);
    // src が変化したら（次曲読み込み等）再度反映
    const obs = new MutationObserver(() => push());
    try { obs.observe(iframe, { attributes: true, attributeFilter: ['src'] }); } catch {}
  }

  // Firefox MV3 ではアップデート時に新規追加された host_permissions が自動付与されない。
  // discogs では youtube.com / youtube-nocookie.com の許可が必須なので、不足していたら
  // パネルの status 行に警告を出してユーザーに popup から承認を促す。
  async function checkYoutubePermission() {
    if (!ext.permissions || !ext.permissions.contains) return true;
    try {
      const granted = await ext.permissions.contains({
        origins: [
          'https://*.youtube.com/*',
          'https://youtube.com/*',
          'https://*.youtube-nocookie.com/*',
          'https://youtube-nocookie.com/*',
        ],
      });
      return granted;
    } catch {
      return true; // チェック不能ならフォールバックで通常動作
    }
  }

  function watchBridgeIframes() {
    console.log('[TEMPO Slider] watching bridge iframes (YouTube / Bandcamp embeds)');
    // discogs サイトでのみ YouTube permission チェック（custom サイトでも有用だが
    // 一旦 discogs のみで案内表示する）
    if (SITE === 'discogs') {
      checkYoutubePermission().then(granted => {
        if (!granted && panelRefs && panelRefs.statusEl) {
          panelRefs.statusEl.textContent = 'YouTube permission missing — click the extension icon to grant';
        }
      });
    }
    // 既存の iframe を捕捉
    const initial = findBridgeIframes();
    console.log('[TEMPO Slider] initial bridge iframes found:', initial.length);
    for (const f of initial) trackBridgeIframe(f);
    // 動的に追加される iframe も追跡
    const observer = new MutationObserver(() => {
      for (const f of findBridgeIframes()) {
        if (!state.bridgeIframes.has(f)) {
          console.log('[TEMPO Slider] new bridge iframe detected:', f.src);
          trackBridgeIframe(f);
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // 各 iframe 内の youtube-bridge.js が起動した際に発火する 'bridgeReady' を受け取り
    // 現在のテンポ／MASTER TEMPO 状態を即座に同期する（iframe リロード時の再同期用）
    window.addEventListener('message', (e) => {
      const data = parseBridgeMsg(e.data);
      if (!data || data[BRIDGE_MSG_TAG] !== true) return;
      if (data.type !== 'bridgeReady') return;
      // 追跡済みの全 iframe に現在値を再送（要素参照経由なので e.source に依存しない）。
      // MutationObserver が iframe 挿入時に登録済みなので、通常はここで確実に反映される。
      for (const iframe of state.bridgeIframes) {
        postToBridge(iframe, 'setRate', { rate: state.tempoRatio });
        if (state.masterTempo) postToBridge(iframe, 'setMasterTempo', { on: true });
        if (state.fx) postToBridge(iframe, 'setFx', { fx: state.fx, bpm: currentHeardBpm() });
      }
      // 未追跡の iframe から来た場合の保険として送信元にも直接返信
      if (e.source) {
        try {
          e.source.postMessage(
            JSON.stringify({ [BRIDGE_MSG_TAG]: true, type: 'setRate', rate: state.tempoRatio }),
            '*'
          );
          if (state.masterTempo) {
            e.source.postMessage(
              JSON.stringify({ [BRIDGE_MSG_TAG]: true, type: 'setMasterTempo', on: true }),
              '*'
            );
          }
        } catch {}
      }
    });
  }

  function attachLightweight(audioEl) {
    if (!audioEl || state.hookedElements.has(audioEl)) return;
    // SoundTouchJS が動作する条件: ブラウザ側のピッチ保持を OFF
    // （CDJ 非 MASTER TEMPO モードでも速度と一緒にピッチが動く挙動になり、CDJ 仕様に合う）
    try { audioEl.preservesPitch = false; } catch {}
    state.hookedElements.add(audioEl);
    // 最初の要素を activeElement に。play 時に切り替わる
    if (!state.activeElement) state.activeElement = audioEl;

    // ユーザーが再生開始した要素を active 扱いにする（MASTER TEMPO / BPM 検知の対象）
    audioEl.addEventListener('play', () => {
      state.activeElement = audioEl;
    });

    // 曲切替検知: 新しい曲が読み込まれたら BPM 情報だけクリア
    // テンポオフセット / MASTER TEMPO は維持（DJ 練習で次曲も同じテンポで継続）
    // 複数 audio がある場合、active な要素の src が変わった時のみ通知する
    let lastTrackKey = getTrackKey(audioEl);
    let lastDuration = audioEl.duration;
    const checkTrackChange = () => {
      const key = getTrackKey(audioEl);
      const dur = audioEl.duration;
      const keyChanged = key && key !== lastTrackKey;
      const durChanged = !isNaN(dur) && !isNaN(lastDuration) && Math.abs(dur - lastDuration) > 0.5;
      if (keyChanged || durChanged) {
        lastTrackKey = key;
        lastDuration = dur;
        if (audioEl === state.activeElement) onTrackChange();
      } else {
        if (key) lastTrackKey = key;
        if (!isNaN(dur)) lastDuration = dur;
      }
    };
    audioEl.addEventListener('loadstart', checkTrackChange);
    audioEl.addEventListener('emptied', checkTrackChange);
    audioEl.addEventListener('durationchange', checkTrackChange);

    // 現在のテンポをこの要素にも反映
    try { audioEl.defaultPlaybackRate = state.tempoRatio; } catch {}
    try { audioEl.playbackRate = state.tempoRatio; } catch {}
  }

  function getTrackKey(audioEl) {
    const src = audioEl.currentSrc || audioEl.src;
    if (!src) return null;
    // クエリストリングは signed URL の場合変わるので除外
    try { return new URL(src).pathname; } catch { return src; }
  }

  function onTrackChange() {
    // BPM 関連のみリセット（テンポオフセット・レンジ・MASTER TEMPO は維持）
    state.originalBpm = null;
    state.tapTimes = [];
    if (state.bpmDetector) {
      try { state.bpmDetector.stop(); } catch {}
      state.bpmDetector = null;
    }
    if (panelRefs) {
      if (panelRefs.originalInput) panelRefs.originalInput.value = '';
      if (panelRefs.statusEl) {
        panelRefs.statusEl.textContent = 'Track changed — BPM cleared';
        setTimeout(() => {
          if (panelRefs && panelRefs.statusEl &&
              panelRefs.statusEl.textContent === 'Track changed — BPM cleared') {
            panelRefs.statusEl.textContent = '';
          }
        }, 2500);
      }
    }
    applyTempo();
  }

  // ============================================================
  // Web Audio グラフ（MASTER TEMPO ON or BPM 自動検知 時に構築）
  // ============================================================
  // DNR で CORS ヘッダーを付与している既知の音源 CDN
  // （これらの host の audio はリロードして crossOrigin='anonymous' に変更可能）
  const CORS_ENABLED_AUDIO_HOSTS = [
    'bcbits.com',     // Bandcamp CDN
    'akamaized.net',  // 一部音源 CDN
  ];

  function isCrossOriginAudio(audioEl) {
    if (!audioEl) return false;
    const src = audioEl.currentSrc || audioEl.src;
    if (!src) return false;
    try {
      const url = new URL(src, location.href);
      return url.origin !== location.origin;
    } catch {
      return false;
    }
  }

  function audioSupportsCors(audioEl) {
    if (!audioEl) return false;
    // ページ側が crossorigin 属性を付けている = サーバが CORS 対応している前提
    if (audioEl.crossOrigin) return true;
    const src = audioEl.currentSrc || audioEl.src;
    if (!src) return false;
    try {
      const url = new URL(src, location.href);
      return CORS_ENABLED_AUDIO_HOSTS.some(d =>
        url.hostname === d || url.hostname.endsWith('.' + d));
    } catch {
      return false;
    }
  }

  async function ensureGraph() {
    const target = state.activeElement;
    if (!target) return false;

    // built-in サイト (bandcamp 等) は DNR で CORS 対応済みなので常に reload 許可。
    // Bandcamp の audio src は `bandcamp.com/stream_redirect?...` という同一オリジン URL だが、
    // 実体は `bcbits.com` へ 302 リダイレクトされ実際は cross-origin なため、
    // URL の見た目では判定できない。
    const isBuiltinSite = !!BUILTIN_HOST[SITE];

    // cross-origin で CORS 対応が不明な音源（custom サイト等）は Web Audio グラフ化しない
    // (crossOrigin リロードで再生破壊する／グラフ経由で muted 出力になるのを防ぐ)
    if (!isBuiltinSite && isCrossOriginAudio(target) && !audioSupportsCors(target)) {
      console.warn('[TEMPO Slider] cross-origin audio without CORS — graph build skipped');
      return false;
    }

    if (state.graphedElement === target) {
      // 既にグラフ構築済みでも、context が suspended のままだと
      // 音が止まったままになるので resume を fire-and-forget で
      // (await すると user activation が消費されて後続 play() が autoplay policy で
      //  ブロックされる可能性があるため)
      if (state.audioCtx && state.audioCtx.state === 'suspended') {
        state.audioCtx.resume().catch(() => {});
      }
      return true;
    }

    if (!state.audioCtx) {
      state.audioCtx = new AudioContext();
    }
    // 新規 AudioContext はブラウザの autoplay policy により suspended で
    // 生成される。resume は fire-and-forget で呼ぶ（await すると user activation が
    // 消費され、後の reload→play() が blocked される）。context が running になる
    // タイミングは createMediaElementSource より遅れても、後で音は鳴り始める。
    if (state.audioCtx.state === 'suspended') {
      state.audioCtx.resume().catch(() => {});
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
      // crossOrigin 未設定で:
      //   - cross-origin audio、または
      //   - built-in サイト（src は同一オリジンに見えても redirect 先が cross-origin の可能性）
      // の場合 reload して CORS リクエストし直す。
      // Bandcamp は audio src が `bandcamp.com/stream_redirect?...` で実体は bcbits.com への 302 リダイレクト。
      // 未対応 CDN へのリロードはサーバ側の CORS ヘッダー欠如で audio が壊れるが、
      // 既に上の early-return で除外済み（built-in は DNR で CORS 対応済み）。
      if (!target.crossOrigin && (isCrossOriginAudio(target) || isBuiltinSite)) {
        const wasPlaying = !target.paused;
        const savedCurrentTime = target.currentTime;
        target.crossOrigin = 'anonymous';
        target.load();
        // load() 直後は readyState=HAVE_NOTHING で currentTime セットが
        // InvalidStateError を投げる場合があるので try-catch で保護
        try { target.currentTime = savedCurrentTime; } catch {}
        if (wasPlaying) {
          target.play().catch(e => console.warn('[TEMPO Slider] play after reload failed:', e.name, e.message));
        }
      }
      // SoundTouchJS が動作する条件: ブラウザ側のピッチ保持を OFF
      try { target.preservesPitch = false; } catch {}
      state.sourceNode = state.audioCtx.createMediaElementSource(target);
      state.gainNode = state.audioCtx.createGain();
      state.graphedElement = target;
      // FX チェーンを 1 度だけ構築（以降は rebuildGraph で結線し直すだけ）。
      // 生成に失敗しても音が途切れないよう防御的に（fxChain=null なら FX なしで素通し）。
      if (!state.fxChain && window.TempoSliderFX) {
        try {
          state.fxChain = window.TempoSliderFX.create(state.audioCtx, { rubberbandReady: state.workletLoaded });
          if (state.fx) state.fxChain.setParams(state.fx, state.originalBpm);
        } catch (e) {
          console.warn('[TEMPO Slider] FX チェーン生成失敗（FX なしで継続）:', e);
          state.fxChain = null;
        }
      }
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
    if (state.fxChain) { try { state.fxChain.output.disconnect(); } catch {} }
    if (state.workletNode) {
      try { state.workletNode.disconnect(); } catch {}
      state.workletNode = null;
    }

    state.gainNode.gain.setValueAtTime(1.0, state.audioCtx.currentTime);

    // masterTempo worklet があればその出力、なければ source を「pre-FX ノード」とする
    let preFx = state.sourceNode;
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
        preFx = state.workletNode;
      } catch (e) {
        console.warn('[TEMPO Slider] worklet ノード作成失敗:', e);
        preFx = state.sourceNode;
      }
    }

    // preFx → [FX チェーン] → gainNode → destination
    if (state.fxChain) {
      preFx.connect(state.fxChain.input);
      state.fxChain.output.connect(state.gainNode);
    } else {
      preFx.connect(state.gainNode);
    }
    state.gainNode.connect(state.audioCtx.destination);

    if (state.bpmDetector) state.bpmDetector.reconnect(state.sourceNode);
  }

  function applyTempo() {
    state.tempoRatio = 1 + state.tempoOffset / 100;
    // ページ上の全 audio 要素にテンポを反映（複数試聴サンプルがあるレコード屋等に対応）
    // defaultPlaybackRate も設定しておくと、次曲ロード時に
    // ブラウザのリソース選択アルゴリズムが playbackRate をリセットする際の
    // リセット先がテンポ比率になり、テンポが維持される
    for (const el of state.hookedElements) {
      try { el.defaultPlaybackRate = state.tempoRatio; } catch {}
      try { el.playbackRate = state.tempoRatio; } catch {}
    }
    if (state.masterTempo && state.workletNode) {
      // Rubber Band の pitch を audio.playbackRate の逆数に設定してピッチを元に戻す
      state.workletNode.port.postMessage(JSON.stringify(['pitch', 1 / state.tempoRatio]));
    }
    // page-inject が読み込まれている環境（Beatport / Traxsource / カスタムサイト）では
    // 捕捉済みの Web Audio バッファソース / Audio 要素に rate を反映する。
    // page-inject が無い環境では誰も listen しないため無害。
    postToPage('setRate', { rate: state.tempoRatio });
    // iframe bridge 経由（discogs 等）: 全 YouTube iframe にテンポを送る
    for (const iframe of state.bridgeIframes) {
      postToBridge(iframe, 'setRate', { rate: state.tempoRatio });
    }
    updateTempoDisplay();
    updateCurrentBpmDisplay();
    // テンポが変わると「聞こえる BPM」も変わるので beat-sync FX を追従させる
    if (state.fxChain) state.fxChain.updateBpm(currentHeardBpm());
    for (const iframe of state.bridgeIframes) {
      postToBridge(iframe, 'setFxBpm', { bpm: currentHeardBpm() });
    }
    if (panelRefs && panelRefs.updateFaderThumb) {
      panelRefs.updateFaderThumb();
    }
  }

  // beat-sync FX が同期すべき「実際に耳に届く BPM」= 原曲 BPM × テンポ比率。
  function currentHeardBpm() {
    return state.originalBpm ? state.originalBpm * state.tempoRatio : null;
  }

  // FX パラメータ（state.fx）を直接経路の FxChain と全 bridge へ反映する。
  // FX を有効にするには Web Audio グラフが必要なので、無ければ構築を試みる。
  async function applyFx() {
    if (!state.fx) return;
    // 直接経路: グラフ未構築なら試みる（試聴要素があるページのみ成功）
    if (!state.fxChain && state.activeElement) {
      await ensureGraph();
    }
    if (state.fxChain) {
      state.fxChain.setParams(state.fx, currentHeardBpm());
    }
    // bridge 経路（YouTube / Bandcamp 埋め込み）へ送信
    for (const iframe of state.bridgeIframes) {
      postToBridge(iframe, 'setFx', { fx: state.fx, bpm: currentHeardBpm() });
    }
  }

  // YouTube iframe 群への MASTER TEMPO 適用（postMessage で各 iframe に依頼）。
  // iframe が無ければ true を返す（no-op 成功扱い）。
  async function applyMasterTempoToIframes(on) {
    const iframes = Array.from(state.bridgeIframes);
    if (iframes.length === 0) return true;
    const results = await Promise.all(iframes.map(iframe => new Promise(resolve => {
      let done = false;
      const handler = (e) => {
        if (e.source !== iframe.contentWindow) return;
        const data = parseBridgeMsg(e.data);
        if (!data || data[BRIDGE_MSG_TAG] !== true) return;
        if (data.type !== 'masterTempoResult') return;
        done = true;
        window.removeEventListener('message', handler);
        resolve(!!data.ok);
      };
      window.addEventListener('message', handler);
      postToBridge(iframe, 'setMasterTempo', { on });
      setTimeout(() => {
        if (!done) {
          window.removeEventListener('message', handler);
          resolve(false);
        }
      }, 5000);
    })));
    // 1つでも成功すれば全体としては OK 扱い
    return results.some(r => r);
  }

  // page-inject 経由の MASTER TEMPO 適用
  function applyMasterTempoViaPageInject(on) {
    return new Promise((resolve) => {
      const handler = (e) => {
        if (e.source !== window || !e.data || e.data[MSG_TAG] !== true) return;
        if (e.data.type === 'masterTempoResult') {
          window.removeEventListener('message', handler);
          resolve(!!e.data.ok);
        }
      };
      window.addEventListener('message', handler);
      postToPage('setMasterTempo', { on });
      // タイムアウト保険
      setTimeout(() => {
        window.removeEventListener('message', handler);
        resolve(false);
      }, 5000);
    });
  }

  // <audio> 要素経由の MASTER TEMPO 適用（Bandcamp / custom の audio 要素対応）
  async function applyMasterTempoToAudio(on) {
    if (on) {
      const ok = await ensureGraph();
      if (!ok) return false;
    }
    state.masterTempo = on; // rebuildGraph が読み取るため
    if (state.sourceNode) rebuildGraph();
    return true;
  }

  async function setMasterTempo(on) {
    if (on === state.masterTempo) return true;
    const previous = state.masterTempo;

    const hasIframes = state.bridgeIframes.size > 0;
    const hasAudio = !!state.activeElement;

    // 各経路を並行実行：
    //   - iframe があれば iframe 経路
    //   - page-inject サイト（Beatport/Traxsource）または audio 要素なし custom サイト
    //     なら page-inject 経路
    //   - audio 要素ありなら audio 直接経路
    // どれもなければ state だけ切り替え（後から要素が見つかれば applyTempo で反映）
    const promises = [];
    if (hasIframes) {
      promises.push(applyMasterTempoToIframes(on));
    }
    if (USES_PAGE_INJECT || (!hasAudio && !hasIframes)) {
      promises.push(applyMasterTempoViaPageInject(on));
    } else if (hasAudio) {
      promises.push(applyMasterTempoToAudio(on));
    }

    if (promises.length === 0) {
      state.masterTempo = on;
      applyTempo();
      return true;
    }

    const results = await Promise.all(promises);
    const ok = results.every(r => r);
    if (ok) {
      state.masterTempo = on;
      applyTempo();
      return true;
    }
    // 部分的失敗 → 状態を巻き戻し、audio 経路で副作用があれば再構築
    state.masterTempo = previous;
    if (state.sourceNode) rebuildGraph();
    applyTempo();
    return false;
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
      // ページ上の全 audio 要素を捕捉（複数試聴サンプル等に対応）
      for (const el of findAudioElements()) {
        if (!state.hookedElements.has(el)) attachLightweight(el);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    for (const el of findAudioElements()) attachLightweight(el);
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
    // beat-sync FX に新しい BPM を反映
    if (state.fxChain) state.fxChain.updateBpm(currentHeardBpm());
    for (const iframe of state.bridgeIframes) {
      postToBridge(iframe, 'setFxBpm', { bpm: currentHeardBpm() });
    }
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
            <div class="tempo-slider__fader-area" title="Shortcuts:  , / .  adjust (Shift = coarse)  ·  R reset  ·  M master  ·  T tap  ·  wheel">
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
            <div class="tempo-slider__iso">
              <div class="tempo-slider__iso-head">
                <span class="tempo-slider__iso-title">ISOLATOR</span>
                <button type="button" class="tempo-slider__fx-btn tempo-slider__iso-btn ts-fx-iso-on"><span class="tempo-slider__fx-led"></span>ON</button>
              </div>
              <div class="tempo-slider__iso-knobs">
                <div class="ts-knob ts-fx-iso-low" title="LOW（中央=0dB / 下げてキル・上げて +6dB ブースト）。ドラッグで回す / ダブルクリックで0">
                  <div class="ts-knob__ring"><div class="ts-knob__dial"><span class="ts-knob__ind"></span></div></div>
                  <span class="ts-knob__cap">LOW</span>
                </div>
                <div class="ts-knob ts-fx-iso-mid" title="MID（中央=0dB / 下げてキル・上げて +6dB ブースト）。ドラッグで回す / ダブルクリックで0">
                  <div class="ts-knob__ring"><div class="ts-knob__dial"><span class="ts-knob__ind"></span></div></div>
                  <span class="ts-knob__cap">MID</span>
                </div>
                <div class="ts-knob ts-fx-iso-high" title="HIGH（中央=0dB / 下げてキル・上げて +6dB ブースト）。ドラッグで回す / ダブルクリックで0">
                  <div class="ts-knob__ring"><div class="ts-knob__dial"><span class="ts-knob__ind"></span></div></div>
                  <span class="ts-knob__cap">HIGH</span>
                </div>
              </div>
            </div>
            <div class="tempo-slider__status"></div>
          </div>
        </div>
        <div class="tempo-slider__fx">
          <button type="button" class="tempo-slider__fx-toggle" aria-expanded="false">FX <span class="tempo-slider__fx-caret">▸</span></button>
          <div class="tempo-slider__fx-panel" hidden>
            <div class="tempo-slider__fx-row">
              <button type="button" class="tempo-slider__fx-btn ts-fx-filter-on"><span class="tempo-slider__fx-led"></span>FILTER</button>
              <span class="tempo-slider__fx-hint">LPF</span>
              <input type="range" class="ts-fx ts-fx-filter" min="-100" max="100" value="0" title="LPF ← → HPF" />
              <span class="tempo-slider__fx-hint">HPF</span>
            </div>
            <div class="tempo-slider__fx-row">
              <button type="button" class="tempo-slider__fx-btn ts-fx-echo-on"><span class="tempo-slider__fx-led"></span>ECHO</button>
              <select class="tempo-slider__fx-sel ts-fx-echo-div" title="Beat division">
                <option value="0.5">1/8</option><option value="1" selected>1/4</option>
                <option value="2">1/2</option><option value="3">3/4</option><option value="4">1/1</option>
              </select>
              <input type="range" class="ts-fx ts-fx-echo-depth" min="0" max="100" value="40" title="Depth" />
            </div>
            <div class="tempo-slider__fx-row">
              <button type="button" class="tempo-slider__fx-btn ts-fx-reverb-on"><span class="tempo-slider__fx-led"></span>REVERB</button>
              <input type="range" class="ts-fx ts-fx-reverb-depth" min="0" max="100" value="35" title="Depth" />
            </div>
            <div class="tempo-slider__fx-row">
              <button type="button" class="tempo-slider__fx-btn ts-fx-trans-on"><span class="tempo-slider__fx-led"></span>TRANS</button>
              <select class="tempo-slider__fx-sel ts-fx-trans-div" title="Beat division">
                <option value="0.25">1/16</option><option value="0.5" selected>1/8</option>
                <option value="1">1/4</option><option value="2">1/2</option>
              </select>
              <input type="range" class="ts-fx ts-fx-trans-depth" min="0" max="100" value="90" title="Depth" />
            </div>
            <div class="tempo-slider__fx-row">
              <button type="button" class="tempo-slider__fx-btn ts-fx-flanger-on"><span class="tempo-slider__fx-led"></span>FLANGER</button>
              <select class="tempo-slider__fx-sel ts-fx-flanger-div" title="LFO period (beats)">
                <option value="2">2</option><option value="4" selected>4</option>
                <option value="8">8</option><option value="16">16</option>
              </select>
              <input type="range" class="ts-fx ts-fx-flanger-depth" min="0" max="100" value="50" title="Depth" />
            </div>
            <div class="tempo-slider__fx-row">
              <button type="button" class="tempo-slider__fx-btn ts-fx-crush-on"><span class="tempo-slider__fx-led"></span>CRUSH</button>
              <select class="tempo-slider__fx-sel ts-fx-crush-bits" title="Bit depth">
                <option value="3">3bit</option><option value="4">4bit</option>
                <option value="6" selected>6bit</option><option value="8">8bit</option>
              </select>
              <input type="range" class="ts-fx ts-fx-crush-depth" min="0" max="100" value="60" title="Mix" />
            </div>
            <div class="tempo-slider__fx-row">
              <button type="button" class="tempo-slider__fx-btn ts-fx-pitch-on"><span class="tempo-slider__fx-led"></span>PITCH</button>
              <input type="range" class="ts-fx ts-fx-pitch-semi" min="-12" max="12" value="0" step="1" title="Semitones" />
              <span class="tempo-slider__fx-val ts-fx-pitch-val">0</span>
            </div>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(panel);

    // panel.css は manifest の content_scripts.css 経由でブラウザが既に注入済みなので
    // ここで <link> を追加する必要はない（カスタムサイトでも WAR/CSP に依存せず確実に適用される）
    // ただし ISO ツマミの CSS だけは content.js から直接注入する（下記参照）。
    injectKnobStyles();
    bindPanelEvents(panel);
  }

  // ISO ツマミ（.ts-knob 系）の CSS を <style> でページに直接注入する。
  // Firefox はアドオン再読込時に content_scripts.css(panel.css) を再注入しないことがあり、
  // JS だけ更新されて CSS が古いままになる。JS は確実に更新されるので、ここから注入すれば齟齬が起きない。
  function injectKnobStyles() {
    if (document.getElementById('tempo-slider-knob-style')) return;
    const css = `
#tempo-slider-panel .tempo-slider__iso-knobs {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: 6px; margin-top: 12px;
  /* 目盛りが水平付近で ±7px ほどノブ枠外に張り出すため、左右にゆとりを取り
     両端の LOW / HIGH を内側（MID 側）へ寄せる（箱外へのはみ出し防止） */
  padding: 0 10px;
}
#tempo-slider-panel .ts-knob {
  display: flex; flex-direction: column; align-items: center; gap: 3px;
  flex: 0 0 auto; cursor: ns-resize; touch-action: none; user-select: none;
}
/* ダイヤルを包む非回転リング。DJM 風の目盛りをこのリングに重ねる（ダイヤルは回転するため別レイヤー） */
#tempo-slider-panel .ts-knob__ring { position: relative; width: 38px; height: 38px; }
#tempo-slider-panel .ts-knob__ticks { position: absolute; inset: 0; pointer-events: none; }
#tempo-slider-panel .ts-knob__tick {
  position: absolute; left: 50%; top: 50%;
  width: 2px; height: 2px; margin: -1px 0 0 -1px;
  border-radius: 50%; background: rgba(255, 255, 255, 0.3);
  transform-origin: center;
}
/* 可動域の両端（-135° / +135°）は長めのライン */
#tempo-slider-panel .ts-knob__tick--end {
  width: 2px; height: 6px; margin: -3px 0 0 -1px;
  border-radius: 1px; background: rgba(255, 255, 255, 0.55);
}
#tempo-slider-panel .ts-knob__dial {
  position: relative; width: 38px; height: 38px; border-radius: 50%;
  background: radial-gradient(circle at 50% 35%, #45454c 0%, #2a2a2e 70%, #1c1c20 100%);
  border: 1px solid rgba(0, 0, 0, 0.6);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.6), inset 0 1px 1px rgba(255, 255, 255, 0.12);
  transform: rotate(0deg);
}
#tempo-slider-panel .ts-knob__ind {
  position: absolute; left: 50%; top: 3px; width: 2px; height: 13px;
  margin-left: -1px; border-radius: 1px; background: #cfd2d6;
}
#tempo-slider-panel .ts-knob.is-off-center .ts-knob__ind {
  background: #ffa020; box-shadow: 0 0 6px rgba(255, 160, 32, 0.9);
}
#tempo-slider-panel .ts-knob.is-active .ts-knob__dial { border-color: rgba(127, 214, 255, 0.5); }
#tempo-slider-panel .ts-knob__cap { font-size: 9px; letter-spacing: 0.06em; color: rgba(255, 255, 255, 0.6); }
`;
    const style = document.createElement('style');
    style.id = 'tempo-slider-knob-style';
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
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
      const payload = { top: rect.top, left: rect.left };
      try {
        const ret = ext.storage.local.set({ [STORAGE_KEY]: payload });
        if (ret && typeof ret.catch === 'function') ret.catch(() => {});
      } catch (e) {}
    }

    // 保存された位置を復元（Promise / Callback 両対応）
    const onRestore = (result) => {
      const pos = result && result[STORAGE_KEY];
      if (pos && typeof pos.top === 'number' && typeof pos.left === 'number') {
        applyPosition(pos.top, pos.left);
      }
    };
    try {
      const ret = ext.storage.local.get(STORAGE_KEY, onRestore);
      if (ret && typeof ret.then === 'function') {
        ret.then(onRestore).catch(() => {});
      }
    } catch (e) {}

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
      // CORS 未対応の cross-origin 音源は事前に拒否（再生破壊回避）
      if (next && state.activeElement &&
          isCrossOriginAudio(state.activeElement) &&
          !audioSupportsCors(state.activeElement)) {
        statusEl.textContent = 'MASTER TEMPO unavailable (cross-origin audio without CORS)';
        return;
      }
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
      if (state.fxChain) state.fxChain.updateBpm(currentHeardBpm());
      for (const iframe of state.bridgeIframes) {
        postToBridge(iframe, 'setFxBpm', { bpm: currentHeardBpm() });
      }
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
      // YouTube iframe しか再生対象が無い場合: cross-origin iframe の音は親で拾えないため AUTO 不可
      if (!state.activeElement && state.bridgeIframes.size > 0 && !USES_PAGE_INJECT) {
        statusEl.textContent = 'AUTO unavailable for embedded players — use TAP';
        return;
      }
      // Beatport / Traxsource: ページから BPM を再取得
      if (USES_PAGE_INJECT) {
        statusEl.textContent = 'Extracting BPM from page...';
        lastExtractedBpm = null;
        const bpm = extractPageBpm();
        if (bpm) {
          setOriginalBpm(bpm);
          statusEl.textContent = `Extracted: ${bpm} BPM`;
        } else {
          statusEl.textContent = 'BPM not found on this page';
        }
        return;
      }

      // BandCamp: 音声解析で BPM 検知
      if (state.bpmDetector) return;
      // CORS 未対応の cross-origin 音源は事前に拒否
      if (state.activeElement &&
          isCrossOriginAudio(state.activeElement) &&
          !audioSupportsCors(state.activeElement)) {
        statusEl.textContent = 'AUTO unavailable (cross-origin audio without CORS)';
        return;
      }
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

    bindFxEvents(panel);

    setupPanelDrag(panel);
    updateTempoDisplay();
  }

  // ============================================================
  // FX（DJM 風エフェクトユニット）UI 配線
  // ============================================================
  function bindFxEvents(panel) {
    if (!state.fx) {
      // fx-chain.js 未ロード環境では FX セクションと常時表示のアイソレーターを隠す
      // （配線されず操作できないため、ダミー表示にならないようにする）
      for (const sel of ['.tempo-slider__fx', '.tempo-slider__iso']) {
        const el = panel.querySelector(sel);
        if (el) el.style.display = 'none';
      }
      return;
    }
    const q = (sel) => panel.querySelector(sel);

    // アイソレーター先行リリース: 他 FX ユニットの UI を隠す（ISOLATOR は別途常時表示）。
    // 配線自体はそのまま行い、コンテナだけ非表示にする（フラグ true で即復活）。
    if (!SHOW_FX_UNIT) {
      const fxSection = q('.tempo-slider__fx');
      if (fxSection) fxSection.style.display = 'none';
    }

    // FX セクションの開閉
    const fxToggle = q('.tempo-slider__fx-toggle');
    const fxPanel  = q('.tempo-slider__fx-panel');
    const caret    = q('.tempo-slider__fx-caret');
    fxToggle.addEventListener('click', () => {
      const open = fxPanel.hasAttribute('hidden');
      if (open) { fxPanel.removeAttribute('hidden'); caret.textContent = '▾'; fxToggle.setAttribute('aria-expanded', 'true'); }
      else { fxPanel.setAttribute('hidden', ''); caret.textContent = '▸'; fxToggle.setAttribute('aria-expanded', 'false'); }
    });

    // on/off ボタン共通ハンドラ
    const bindToggle = (sel, key) => {
      const btn = q(sel);
      if (!btn) return;
      btn.addEventListener('click', () => {
        state.fx[key].on = !state.fx[key].on;
        btn.classList.toggle('is-on', state.fx[key].on);
        applyFx();
      });
    };
    // range/select 共通ハンドラ
    const bindRange = (sel, setter) => {
      const el = q(sel);
      if (!el) return;
      el.addEventListener('input', () => { setter(el.value); applyFx(); });
    };
    // ロータリーツマミ（DJ 機材風）: 縦ドラッグ／ホイールで -1..+1、ダブルクリックで 0。
    // get/set は値域 -1..+1。set 内で applyFx を呼ぶ想定。
    const bindKnob = (el, get, set) => {
      if (!el) return;
      const dial = el.querySelector('.ts-knob__dial');
      const DEG = 135; // 中央0 のとき ±135° まで回る
      // DJM 風の目盛り（ドット＋両端ライン）を非回転リングに重ねて描画する。
      // ノブの可動域 ±135°（計 270°）に沿って配置。両端は長いライン、中間はドット。
      const ring = el.querySelector('.ts-knob__ring');
      if (ring && !ring.querySelector('.ts-knob__ticks')) {
        const ticks = document.createElement('div');
        ticks.className = 'ts-knob__ticks';
        const N = 11;
        for (let i = 0; i < N; i++) {
          const angle = -DEG + (2 * DEG / (N - 1)) * i; // -135 .. +135
          const tick = document.createElement('span');
          tick.className = 'ts-knob__tick' + ((i === 0 || i === N - 1) ? ' ts-knob__tick--end' : '');
          tick.style.transform = `rotate(${angle}deg) translateY(-26px)`;
          ticks.appendChild(tick);
        }
        ring.appendChild(ticks);
      }
      const render = () => {
        const v = Math.max(-1, Math.min(1, get()));
        if (dial) dial.style.transform = `rotate(${v * DEG}deg)`;
        el.classList.toggle('is-off-center', Math.abs(v) > 0.02);
      };
      render();
      let dragging = false, startY = 0, startV = 0;
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        dragging = true; startY = e.clientY; startV = get();
        try { el.setPointerCapture(e.pointerId); } catch {}
        el.classList.add('is-active');
      });
      el.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        // 120px 動かして片側フルレンジ（Shift で微調整）
        const span = e.shiftKey ? 480 : 120;
        const v = Math.max(-1, Math.min(1, startV + (startY - e.clientY) / span));
        set(v); render();
      });
      const endDrag = (e) => {
        if (!dragging) return;
        dragging = false;
        try { el.releasePointerCapture(e.pointerId); } catch {}
        el.classList.remove('is-active');
      };
      el.addEventListener('pointerup', endDrag);
      el.addEventListener('pointercancel', endDrag);
      el.addEventListener('wheel', (e) => {
        e.preventDefault();
        const step = e.shiftKey ? 0.2 : 0.05;
        const v = Math.max(-1, Math.min(1, get() + (e.deltaY < 0 ? step : -step)));
        set(v); render();
      }, { passive: false });
      el.addEventListener('dblclick', () => { set(0); render(); });
    };

    // FILTER（ON/OFF + amount。中央=フラット）
    bindToggle('.ts-fx-filter-on', 'filter');
    bindRange('.ts-fx-filter', (v) => { state.fx.filter.amount = parseInt(v, 10) / 100; });

    // ISO（3バンドアイソレーター・ON/OFF + ツマミUI）
    bindToggle('.ts-fx-iso-on', 'iso');
    bindKnob(q('.ts-fx-iso-low'),  () => state.fx.iso.low,  (v) => { state.fx.iso.low  = v; applyFx(); });
    bindKnob(q('.ts-fx-iso-mid'),  () => state.fx.iso.mid,  (v) => { state.fx.iso.mid  = v; applyFx(); });
    bindKnob(q('.ts-fx-iso-high'), () => state.fx.iso.high, (v) => { state.fx.iso.high = v; applyFx(); });

    // ECHO
    bindToggle('.ts-fx-echo-on', 'echo');
    bindRange('.ts-fx-echo-div',   (v) => { state.fx.echo.division = parseFloat(v); });
    bindRange('.ts-fx-echo-depth', (v) => { state.fx.echo.depth = parseInt(v, 10) / 100; });

    // TRANS
    bindToggle('.ts-fx-trans-on', 'trans');
    bindRange('.ts-fx-trans-div',   (v) => { state.fx.trans.division = parseFloat(v); });
    bindRange('.ts-fx-trans-depth', (v) => { state.fx.trans.depth = parseInt(v, 10) / 100; });

    // FLANGER
    bindToggle('.ts-fx-flanger-on', 'flanger');
    bindRange('.ts-fx-flanger-div',   (v) => { state.fx.flanger.division = parseFloat(v); });
    bindRange('.ts-fx-flanger-depth', (v) => { state.fx.flanger.depth = parseInt(v, 10) / 100; });

    // REVERB
    bindToggle('.ts-fx-reverb-on', 'reverb');
    bindRange('.ts-fx-reverb-depth', (v) => { state.fx.reverb.depth = parseInt(v, 10) / 100; });

    // CRUSH
    bindToggle('.ts-fx-crush-on', 'crush');
    bindRange('.ts-fx-crush-bits',  (v) => { state.fx.crush.bits = parseInt(v, 10); });
    bindRange('.ts-fx-crush-depth', (v) => { state.fx.crush.depth = parseInt(v, 10) / 100; });

    // PITCH
    bindToggle('.ts-fx-pitch-on', 'pitch');
    const pitchVal = q('.ts-fx-pitch-val');
    bindRange('.ts-fx-pitch-semi', (v) => {
      state.fx.pitch.semitones = parseInt(v, 10);
      if (pitchVal) pitchVal.textContent = (v > 0 ? '+' : '') + v;
    });
  }

  // キーボードショートカット
  // テキスト入力中 (input/textarea/select/contenteditable/ARIA textbox 等) は無効。
  // composedPath() を優先的に見るのは、Bandcamp のヘッダー検索や、
  // シャドウ DOM を使うサイトの検索入力にフォーカスがある場合、
  // 外側から document.activeElement を見てもラッパー要素しか取れず
  // input を検出できないため。
  function isEditableNode(node) {
    if (!node || !node.tagName) return false;
    const tag = node.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (node.isContentEditable) return true;
    if (tag === 'IFRAME') return true;
    const role = node.getAttribute && node.getAttribute('role');
    if (role === 'textbox' || role === 'searchbox' || role === 'combobox') return true;
    return false;
  }

  function isTyping(e) {
    if (e && typeof e.composedPath === 'function') {
      const path = e.composedPath();
      for (const node of path) {
        if (isEditableNode(node)) return true;
      }
    }
    return isEditableNode(document.activeElement);
  }

  document.addEventListener('keydown', (e) => {
    if (isTyping(e)) return;
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

  // ============================================================
  // ============================================================
  // ページから BPM を自動取得（Beatport / Traxsource 等の専用クラスや一般的テキストから）
  function extractPageBpm() {
    if (!USES_PAGE_INJECT) return null;
    // 1) サイト固有のクラス指定（観測した DOM パターン）
    //    Beatport: <p class="Player-style__BPMInfo-...">125 bpm</p>
    //    Traxsource は未確認だが "bpm" を含むクラスを使うことが多い
    const classSelectors = ['[class*="BPMInfo"]', '[class*="bpm" i]'];
    for (const sel of classSelectors) {
      try {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          const m = (el.textContent || '').match(/(\d{2,3}(?:\.\d+)?)/);
          if (m) {
            const bpm = parseFloat(m[1]);
            if (bpm >= 50 && bpm <= 220) return Math.round(bpm);
          }
        }
      } catch (e) {}
    }
    // 2) フォールバック: ページテキスト全体から
    const bodyText = document.body.innerText || '';
    const patterns = [
      /(\d{2,3}(?:\.\d+)?)\s*bpm/i,            // "125 bpm"
      /bpm\s*[:：]?\s*(\d{2,3}(?:\.\d+)?)/i,    // "BPM: 125"
    ];
    for (const p of patterns) {
      const m = bodyText.match(p);
      if (m) {
        const bpm = parseFloat(m[1]);
        if (bpm >= 50 && bpm <= 220) return Math.round(bpm);
      }
    }
    return null;
  }

  let lastExtractedBpm = null;
  function maybeExtractPageBpm() {
    const bpm = extractPageBpm();
    if (bpm && bpm !== lastExtractedBpm) {
      lastExtractedBpm = bpm;
      setOriginalBpm(bpm);
    }
  }

  function setupPageInjectIntegration() {
    // BPM 自動取得: 初回 + URL 変化 + DOM 変化（debounce 付き）
    let extractTimer = null;
    function schedule() {
      if (extractTimer) clearTimeout(extractTimer);
      extractTimer = setTimeout(maybeExtractPageBpm, 400);
    }
    setTimeout(schedule, 1000);
    let lastUrl = location.href;
    const observer = new MutationObserver(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        lastExtractedBpm = null;
      }
      schedule();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // 起動
  // パネル注入は同期的に行う（disabledBuiltins チェックの await を待たない）。
  // これにより storage アクセスの遅延や障害があっても、組み込みサイトでは
  // 確実にパネルが表示される。disabled の場合は後から panel を取り除く。
  function init() {
    console.log('[TEMPO Slider] content.js init, SITE=', SITE, 'host=', location.hostname);
    injectPanel();
    // audio と YouTube iframe の両方を監視
    // （custom サイトで両方が混在するページに対応するため）
    // - bandcamp/beatport/traxsource: ほぼ audio のみ → iframe 監視は no-op
    // - discogs: ほぼ iframe のみ → audio 監視は no-op
    // - youtube: 同一ウィンドウの youtube-bridge.js が <video> を制御
    // - custom: 両方の可能性あり
    watchAudioChanges();
    watchBridgeIframes();
    if (USES_SELF_BRIDGE) {
      // YouTube ページ自身では <iframe> ではなくページ自身に youtube-bridge.js が
      // 注入されているので、window 自体を擬似 bridge ターゲットとして登録する。
      // 既存の postToBridge / trackBridgeIframe のコードは iframe.contentWindow を
      // 使うので、{ contentWindow: window } を渡せばそのまま動く。
      trackBridgeIframe({ contentWindow: window });
    }
    // page-inject へ worklet URL を渡しておく（カスタムサイトを含めて
    // MASTER TEMPO 経路で worklet が必要になった時のため）
    postToPage('init', { workletUrl: ext.runtime.getURL('rubberband-worklet.js') });
    if (USES_PAGE_INJECT) setupPageInjectIntegration();

    document.addEventListener('click', () => {
      if (state.audioCtx && state.audioCtx.state === 'suspended') {
        state.audioCtx.resume();
      }
    }, true);
  }

  function teardown() {
    const panel = document.getElementById('tempo-slider-panel');
    if (panel) panel.remove();
  }

  init();

  // disabled state の async チェック → disabled なら teardown
  const builtinHost = BUILTIN_HOST[SITE];
  if (builtinHost) {
    ext.storage.local.get('disabledBuiltins').then(result => {
      const disabled = Array.isArray(result.disabledBuiltins) &&
        result.disabledBuiltins.includes(builtinHost);
      if (disabled) teardown();
    }).catch(() => {});
  }

  // worklet をページロード時に事前ロード。
  // MASTER TEMPO/AUTO 押下時の `await audioWorklet.addModule()` を排除し、
  // user gesture を `audio.play()` まで保持させる（さもないと
  // autoplay policy で reload 後の play() がブロックされる）。
  // AudioContext は suspended で生成され、ボタン押下時にユーザー操作で resume する。
  (function preloadWorklet() {
    try {
      if (!state.audioCtx) state.audioCtx = new AudioContext();
      if (state.workletLoaded) return;
      state.audioCtx.audioWorklet.addModule(ext.runtime.getURL('rubberband-worklet.js'))
        .then(() => { state.workletLoaded = true; })
        .catch(e => console.warn('[TEMPO Slider] worklet preload failed:', e));
    } catch (e) {
      // AudioContext 生成に失敗する環境では preload を諦め、ensureGraph 内で再試行
      console.warn('[TEMPO Slider] preloadWorklet failed:', e);
    }
  })();
})();
