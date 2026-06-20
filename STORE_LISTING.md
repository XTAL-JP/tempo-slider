# Store Listing Copy

ストア提出時にコピペで使えるテキスト集。

## 名前 / Name

`TEMPO Slider`

## カテゴリ

- Chrome Web Store: Productivity (もしくは Entertainment)
- Firefox AMO: Other / Music

## 短い説明 / Short description

### English (≤132 chars for Chrome Web Store)
```
CDJ-style tempo / pitch keep controls for music purchase sites. Preview tracks at your target BPM. Bandcamp / Beatport / Traxsource.
```

### 日本語
```
DJ向け音源販売サイト用 CDJ風テンポコントロール。Bandcamp / Beatport / Traxsource 対応。Rubber Band Library で DAW級ピッチキープ。
```

## 概要 / Summary (AMO, ≤250 chars)

### English
```
CDJ-style tempo and pitch controls overlay for music purchase sites. Listen to track previews at your target BPM with DAW-grade master tempo (pitch preservation) using Rubber Band Library. Built-in support for Bandcamp, Beatport, Traxsource.
```

### 日本語
```
DJ向け音源販売サイトに Pioneer CDJ 風のテンポ・ピッチコントロールを追加。試聴音源を目標 BPM で聴けます。MASTER TEMPO で音程を保ったままテンポ変更可能 (Rubber Band Library 採用、DAW 級品質)。Bandcamp・Beatport・Traxsource 対応。
```

## 詳細説明 / Detailed description

### English

```
TEMPO Slider adds a Pioneer CDJ-style tempo control panel to music purchase sites, designed for DJs and music collectors who want to preview tracks at a target BPM before buying.

KEY FEATURES
• Pioneer CDJ-style vertical TEMPO fader with ±6 / ±10 / ±16 / WIDE range
• MASTER TEMPO (pitch keep) using DAW-grade Rubber Band Library compiled to WebAssembly
• BPM display with automatic extraction on Beatport / Traxsource, or manual tap input
• Keyboard shortcuts: , / . for fine adjust (Shift = coarse), R reset, M master tempo, T tap
• Mouse wheel on fader for precise control
• Draggable panel with position memory

SUPPORTED SITES (BUILT-IN)
• Bandcamp (bandcamp.com)
• Beatport (beatport.com)
• Traxsource (traxsource.com)

ADDING YOUR OWN SITES
Click the extension icon on any other music site to add it. The extension will request permission, then enable the tempo control panel.

USE CASES
• Preview tracks at your target mixing BPM before purchasing
• Audition tracks at slower or faster tempo while keeping the original pitch
• Tap to set source BPM and see live "current BPM" feedback as you move the fader

PRIVACY
This extension does NOT collect, track, or transmit any data. All processing happens locally in your browser. Source code is open at https://github.com/XTAL-JP/tempo-slider under GPL-2.0.

Note: this extension uses declarativeNetRequest to add CORS headers and remove Content-Security-Policy headers on supported sites. This is required for the audio processing pipeline (Rubber Band WASM library) to function inside the page's audio context. No data is sent externally.
```

### 日本語

```
TEMPO Slider は、DJ 向け音源販売サイトに Pioneer CDJ 風のテンポコントロールパネルを追加するブラウザ拡張機能です。試聴音源を目標 BPM で聴いてから購入したい DJ や音楽コレクター向けに設計されています。

主な機能
• Pioneer CDJ 風の垂直 TEMPO フェーダー (±6 / ±10 / ±16 / WIDE レンジ)
• MASTER TEMPO (ピッチキープ) — DAW で使われる Rubber Band Library を WebAssembly で組み込み
• BPM 表示 — Beatport / Traxsource はページから自動取得、または手動タップ入力
• キーボードショートカット: , / . でテンポ微調整 (Shift で粗調整)、R リセット、M MASTER TEMPO、T タップ
• フェーダー上でマウスホイールによる精密制御
• ヘッダーを掴んでパネルを移動可能 (位置は記憶)

対応サイト (ビルトイン)
• Bandcamp
• Beatport
• Traxsource

その他のサイトの追加
他の音楽サイトで拡張機能アイコンをクリックすると、そのサイトを追加できます。許可確認のあとテンポコントロールパネルが有効化されます。

ユースケース
• 購入前にミックス先の BPM でトラックを試聴
• 元のピッチを保ったままテンポを下げ/上げて確認
• タップで原曲 BPM を設定 → フェーダー操作中の「現在 BPM」がリアルタイムで表示

プライバシー
この拡張機能はデータの収集・追跡・送信を一切行いません。すべての処理はブラウザ内で完結します。ソースコードは https://github.com/XTAL-JP/tempo-slider で GPL-2.0 ライセンスで公開しています。

注: 対応サイトで音声処理パイプライン (Rubber Band WASM ライブラリ) を動かすため、declarativeNetRequest 機能で CORS ヘッダの追加と Content-Security-Policy ヘッダの削除を行っています。外部へのデータ送信はありません。
```

## Single Purpose Description (Chrome Web Store 必須)

```
Apply Pioneer CDJ-style tempo and pitch keep controls to audio playing on supported music purchase sites, so DJs can preview tracks at their target BPM before buying.
```

## 権限の理由 / Permission justifications (Chrome Web Store)

| Permission | Justification |
|---|---|
| `activeTab` | Read the current tab's URL when the user clicks "+ Add this site" in the popup. |
| `storage` | Save the user's preferred panel position and the list of custom sites they have added. |
| `scripting` | Inject the tempo control script into custom sites that the user has explicitly added via the popup. |
| `declarativeNetRequest`, `declarativeNetRequestWithHostAccess` | Add CORS headers to supported sites' audio CDN responses (so the extension can route audio through Web Audio for pitch processing). Also remove Content-Security-Policy headers on supported pages so the bundled Rubber Band (WebAssembly) library can use new Function() — required by Emscripten's runtime. Modifications are limited to the host permissions granted to the extension. |
| `host_permissions` (bandcamp / bcbits / beatport / traxsource / akamaized) | Required to inject the tempo control panel and audio processing into the built-in supported sites. |
| `optional_host_permissions` (`https://*/*`) | Reserved for sites the user explicitly adds via the popup. Not granted by default; the user is prompted at the time of adding. |

## Privacy policy URL

```
https://xtal-jp.github.io/tempo-slider/privacy.html
```
(GitHub Pages を有効化後に公開される URL。docs/privacy.html を配置済み)

## Homepage URL

```
https://github.com/XTAL-JP/tempo-slider
```

## Support URL

```
https://github.com/XTAL-JP/tempo-slider/issues
```
