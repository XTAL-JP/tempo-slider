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
Pitch-preserving DJ tempo control on YouTube, Bandcamp, Discogs, Beatport, Traxsource — plus any site you add. DAW-grade.
```

### 日本語
```
DJ向け、ピッチを保ったままテンポを変える MASTER TEMPO — YouTube / Bandcamp / Discogs / Beatport / Traxsource ほか任意追加対応。DAW級。
```

## 概要 / Summary (AMO, ≤250 chars)

### English
```
CDJ-style vertical fader with DAW-grade MASTER TEMPO (Rubber Band Library). YouTube, Bandcamp, Discogs, Beatport, Traxsource — plus any site you add. For DJs and crate diggers previewing tracks at their target BPM.
```

### 日本語
```
Rubber Band Library 採用の DAW 級 MASTER TEMPO（ピッチキープ）と CDJ 風縦フェーダー。YouTube / Bandcamp / Discogs / Beatport / Traxsource + popup から任意サイトを追加可能。目標 BPM でトラック試聴したい DJ・クレートディガー向け。
```

## 詳細説明 / Detailed description

### English

```
TEMPO Slider gives DJs and crate diggers DAW-grade pitch-preserving tempo control across multiple music stores. Hear track previews at your target BPM without the chipmunk effect — just like a real CDJ.

WHY THIS EXTENSION
Other tempo extensions are usually single-site, and most just change playbackRate (which shifts the pitch with the tempo). TEMPO Slider works on multiple stores and uses the same DAW-grade pitch-shifting engine (Rubber Band Library, compiled to WebAssembly) that professional audio software relies on — so you can change tempo while keeping the original key.

KEY FEATURES
• MASTER TEMPO (pitch keep) — DAW-grade Rubber Band Library via WebAssembly. Change tempo while keeping the original key/pitch.
• Multi-site: YouTube, Bandcamp, Discogs, Beatport, Traxsource — plus any site you add via the popup.
• CDJ-style vertical TEMPO fader with ±6 / ±10 / ±16 / WIDE range.
• BPM display: manual TAP, audio-based AUTO detection, and DOM extraction on Beatport / Traxsource.
• Keyboard shortcuts (, / . for fine adjust, Shift for coarse, R reset, M master, T tap) and mouse wheel on the fader.
• Draggable panel with position memory.
• Multiple <audio> elements on a page are all controlled simultaneously (record-store-style preview lists).
• On Discogs, the panel controls the embedded YouTube preview directly — DAW-grade pitch keep applied to YouTube playback.

SUPPORTED SITES (BUILT-IN)
• YouTube (www.youtube.com — direct watch pages)
• Bandcamp (bandcamp.com)
• Discogs (discogs.com — YouTube previews on release pages)
• Beatport (beatport.com)
• Traxsource (traxsource.com)

ADDING YOUR OWN SITES
Click the extension icon on any other music site to add it. The extension will request permission, then enable the tempo control panel.

USE CASES
• Preview tracks at your target mixing BPM across stores before purchasing
• Practice mixing along to YouTube DJ sets at your own tempo
• Slow down or speed up while keeping the original key — for transcription, vocal practice, or DJ prep
• Tap to set source BPM and see live "current BPM" feedback as you move the fader

PRIVACY
This extension does NOT collect, track, or transmit any data. All processing happens locally in your browser. Source code is open at https://github.com/XTAL-JP/tempo-slider under GPL-2.0.

Note: this extension uses declarativeNetRequest to add CORS headers and remove Content-Security-Policy headers on supported sites. This is required for the audio processing pipeline (Rubber Band WASM library) to function inside the page's audio context. No data is sent externally.
```

### 日本語

```
TEMPO Slider は、DJ・クレートディガー向けに DAW 級のピッチキープ付きテンポコントロールを複数の音源販売サイトに追加するブラウザ拡張機能です。試聴音源を目標 BPM で聴いても、音程は元のまま——本物の CDJ と同じ操作感です。

この拡張機能の特徴
他のテンポ系拡張機能の多くは単一サイトのみの対応で、再生速度（playbackRate）を変えるだけ＝音程も一緒に変わってしまいます。TEMPO Slider は複数ストア対応で、プロ向け音声編集ソフトでも使われている Rubber Band Library（WebAssembly 化）でピッチを保ったままテンポだけを変更できます。

主な機能
• MASTER TEMPO（ピッチキープ）— DAW で使われる Rubber Band Library を WebAssembly で組み込み。テンポを変えても音程は元のまま。
• マルチサイト対応: YouTube / Bandcamp / Discogs / Beatport / Traxsource、さらに popup から任意のサイトを追加可能。
• CDJ 風の縦 TEMPO フェーダー（±6 / ±10 / ±16 / WIDE レンジ）。
• BPM 表示: 手動 TAP、音声解析の AUTO 検知、Beatport / Traxsource はページから自動取得。
• キーボードショートカット（, / . で微調整、Shift で粗調整、R リセット、M MASTER TEMPO、T タップ）とマウスホイール対応。
• ヘッダーを掴んでパネルを移動可能（位置は記憶）。
• 1 ページに複数 <audio> がある場合（試聴サンプルが複数並ぶレコード店ページ等）、全てに同時にテンポが反映されます。
• Discogs では埋め込みの YouTube 試聴を直接制御 — DAW 級ピッチキープが YouTube 再生にも適用されます。

対応サイト（ビルトイン）
• YouTube（www.youtube.com — 動画視聴ページ）
• Bandcamp
• Discogs（リリースページの YouTube 試聴）
• Beatport
• Traxsource

その他のサイトの追加
他の音楽サイトで拡張機能アイコンをクリックすると、そのサイトを追加できます。許可確認のあとテンポコントロールパネルが有効化されます。

ユースケース
• 複数ストアを横断して、購入前にミックス先の BPM でトラックを試聴
• YouTube の DJ セットを自分のテンポに合わせて練習
• キー（音程）を保ったまま速度を変更——耳コピ・ヴォーカル練習・DJ プレイ準備に
• タップで原曲 BPM を設定 → フェーダー操作中の「現在 BPM」がリアルタイム表示

プライバシー
この拡張機能はデータの収集・追跡・送信を一切行いません。すべての処理はブラウザ内で完結します。ソースコードは https://github.com/XTAL-JP/tempo-slider で GPL-2.0 ライセンスで公開しています。

注: 対応サイトで音声処理パイプライン（Rubber Band WASM ライブラリ）を動かすため、declarativeNetRequest 機能で CORS ヘッダーの追加と Content-Security-Policy ヘッダーの削除を行っています。外部へのデータ送信はありません。
```

## Single Purpose Description (Chrome Web Store 必須)

```
Provide DAW-grade pitch-preserving tempo control on multiple music purchase sites so DJs can preview tracks at their target BPM without changing the key.
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

## Version notes / バージョンごとの説明文

各ストア（AMO / Chrome Web Store）の「このバージョンについて」「リリースノート」欄に貼るテキスト。

### 0.10.9 — YouTube support + upload-blocking bug fix

#### English (AMO / Chrome Web Store)
```
New: YouTube (www.youtube.com) is now a first-class supported site. The tempo control panel appears on YouTube watch pages directly, with DAW-grade MASTER TEMPO (pitch keep) applied to the video's audio. studio.youtube.com, m.youtube.com, and music.youtube.com remain excluded so they keep working normally.

Bug fix: If you previously added a site via "+ Add this site", an overly broad CORS-header rule could break credentialed XHR responses on that site — for example, YouTube Studio uploads getting stuck at 0%. The dynamic CORS rule is now scoped to media responses only (matching the static rules), and existing rules are migrated automatically when the extension starts.

Safety: The "+ Add this site" button now refuses to add hostnames that are already covered by built-in support (bandcamp / beatport / traxsource / discogs / youtube / bcbits) or Google / CDN infrastructure (google.com / googleapis.com / googleusercontent.com / googlevideo.com / gstatic.com / akamaized.net). Any such entries left over from older versions are automatically removed on startup.
```

#### 日本語
```
新機能: YouTube (www.youtube.com) を正式サポートサイトに追加しました。YouTube の動画視聴ページで TEMPO Slider のパネルが直接表示され、DAW 級 MASTER TEMPO（ピッチキープ）が動画再生にも適用されます。studio.youtube.com / m.youtube.com / music.youtube.com は通常動作維持のため対象外。

不具合修正: 「+ Add this site」で過去に追加したサイトについて、動的な CORS ヘッダールールの範囲が広すぎて認証付き XHR 応答を壊すケースがありました（例: YouTube Studio のアップロードが 0% で停止）。動的 CORS ルールを静的ルールと同じく media 応答のみに絞り、起動時に既存ルールを自動マイグレーションします。

安全性向上: 「+ Add this site」ボタンは、すでに組み込み対応されているサイト（bandcamp / beatport / traxsource / discogs / youtube / bcbits）や Google / CDN インフラ（google.com / googleapis.com / googleusercontent.com / googlevideo.com / gstatic.com / akamaized.net）の追加を拒否するようになりました。古いバージョンで誤って追加されていた場合は起動時に自動的に削除されます。
```

### 0.10.0 — Discogs support

#### English (AMO / Chrome Web Store)
```
Adds support for Discogs (discogs.com). The tempo control panel now appears on Discogs release pages and controls the embedded YouTube preview directly — DAW-grade MASTER TEMPO (pitch keep via Rubber Band Library) is applied to YouTube playback.

For Firefox users upgrading from a previous version:
Firefox treats newly added host permissions as optional, so the new Discogs / YouTube access is NOT auto-granted on upgrade. On your first visit to discogs.com after upgrading, click the extension icon and press the "Grant permission" button shown in the popup. After granting, reload the tab and the panel will appear automatically on subsequent visits.

For new installs and Chrome users: no manual action required — permissions are granted as part of the normal install flow.
```

#### 日本語
```
Discogs (discogs.com) に対応しました。Discogs のリリースページでテンポコントロールパネルが表示され、埋め込みの YouTube 試聴を直接制御します。DAW 級 MASTER TEMPO（Rubber Band Library によるピッチキープ）が YouTube 再生にも適用されます。

Firefox で既存バージョンからアップデートする方へ:
Firefox では新規追加された host permissions は自動付与されない仕様のため、Discogs / YouTube への新規アクセス権限はアップデート時に自動では有効になりません。アップデート後はじめて discogs.com を開いた際、拡張機能アイコンをクリックし popup の「Grant permission」ボタンを押してください。承認後にタブがリロードされ、以降は通常通りパネルが自動で表示されます。

新規インストール・Chrome ユーザーの方: 通常のインストール時に権限が付与されるため、特別な操作は不要です。
```
