# TEMPO Slider

Pioneer CDJ 風の UI で、ブラウザで再生中の音楽（BandCamp など）のテンポを変えて聴くための拡張機能。
DJ 練習用。

## キーボードショートカット

- `,` / `.` : テンポ ±0.1%（Shift 併用で ±1.0%）
- `R` : TEMPO RESET（0% に戻す）
- `M` : MASTER TEMPO 切替（ピッチキープ）
- `T` : TAP（タップテンポ）
- フェーダー上でマウスホイール: ±0.1%（Shift 押下中は ±1.0%）

テキスト入力中は全て無効化されます。

※ UI 表示は英語（CDJ 風）、コード内コメントは日本語。

## 機能（Pioneer CDJ 風）

- **TEMPO レンジセレクター**: ±6 / ±10 / ±16 / WIDE(±50)
- **垂直 TEMPO フェーダー**: 上が「−」(遅い)、下が「+」(速い)、中央 0
- **TEMPO RESET ボタン**: フェーダーを 0 に戻す
- **MASTER TEMPO ボタン**: ON にするとピッチキープ。赤 LED 点灯で状態表示
- **テンポ値表示**: 「+0.0%」形式（リアルタイム）
- **BPM 入力 / TAP / 自動検知**: 原曲 BPM の取得
- **現在 BPM 表示**: 原曲 BPM × 速度倍率をリアルタイム表示

## 現在の対応サイト

- BandCamp (`*.bandcamp.com`)

## 開発状況

- [x] 拡張機能スケルトン（Chrome / Firefox 128+ 共通 MV3）
- [x] 速度変更（ピッチ変動モード）
- [x] UI パネル
- [x] CORS 対応（declarativeNetRequest で bcbits.com のレスポンスヘッダ書き換え）
- [x] **ピッチキープモード**（グラニュラーシンセシスによる自前ピッチシフター）
- [x] BPM 表示（原曲BPM × 速度倍率 = 現在BPM）
- [x] BPM タップ入力
- [x] BPM 自動検知（低音域ピーク検出 + 中央値、12秒解析）
- [x] CDJ 風 UI（縦フェーダー、レンジ切替、目盛り、センター緑LED）
- [x] カスタムフェーダー（div ベース、Pointer Events ドラッグ）
- [x] マウスホイール / キーボードショートカット
- [x] ピッチシフター改良（Catmull-Rom 3次補間 + 8倍オーバーラップ）
- [x] SoundTouchJS AudioWorklet 試行 → クリップノイズが残り断念
- [x] **Rubber Band Library (WASM) に切り替え**（DAW 級品質）
  - BandCamp の CSP を declarativeNetRequest で除去（Emscripten が `new Function()` を使うため。BandCamp ページ上で eval が許可されるセキュリティ的トレードオフあり）
- [ ] BPM 検知の精度向上
- [x] パネル位置のドラッグ移動 + 記憶（chrome.storage.local）
- [ ] 対応サイト拡張（YouTube / SoundCloud など）

## インストール（開発版）

Chrome / Firefox 両方とも MV3 の単一 `src/manifest.json` を使う。

### Chrome

1. `chrome://extensions/` を開く
2. デベロッパーモードを ON
3. 「パッケージ化されていない拡張機能を読み込む」で `src/` ディレクトリを選択

### Firefox（109 以降）

1. `about:debugging#/runtime/this-firefox` を開く
2. 「一時的なアドオンを読み込む」で `src/manifest.json` を選択
3. ※ ファイル名が `manifest.json` であることが必須（別名だと "does not contain a valid manifest" エラーになる）

## ピッチシフター

`src/rubberband-worklet.js` は [rubberband-web](https://github.com/delude88/rubberband-web) v0.2.1 を vendor したもの。中身は WASM 化された [Rubber Band Library](https://breakfastquay.com/rubberband/)（DAW 級品質）。

ライセンス: **GPL-2.0-or-later**（Rubber Band 由来）。本拡張機能の配布も同ライセンスに従う必要あり。

更新するには:

```bash
npm pack rubberband-web
tar -xzf rubberband-web-*.tgz
cp package/public/rubberband-processor.js src/rubberband-worklet.js
```

API: `port.postMessage(JSON.stringify([command, value]))` 形式
- `['pitch', ratio]`: ピッチ倍率（1.0 = 元のまま）
- `['tempo', ratio]`: タイムストレッチ倍率
- `['quality', bool]`: 高品質モード（CPU 使用量増、本拡張では ON）

本拡張のアーキテクチャ:
- `audio.playbackRate = tempoRatio` で速度＋ピッチを変える（要素側）
- `worklet.setPitch(1/tempoRatio)` で逆方向にピッチを補正
- `audio.preservesPitch = false` でブラウザの自動ピッチ補正を無効化

## ファイル構成

```
src/
├── manifest.json            # MV3 マニフェスト（Chrome / Firefox 128+ 両対応）
├── rules.json               # declarativeNetRequest ルール（bcbits.com の CORS 解決）
├── content.js               # メインロジック（audio 要素フック・グラフ構築・UI）
├── panel.css                # コントロールパネルのスタイル
└── soundtouch-worklet.js    # グラニュラーシンセシス・ピッチシフター
```
