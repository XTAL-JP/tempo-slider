# TEMPO Slider

Pioneer CDJ 風のテンポ・ピッチコントロールをブラウザに追加する拡張機能。
DJ 用音源販売サイトでクレートディグ中に、購入前のトラック試聴を**ターゲット BPM・ピッチキープで**聴けます。

![icon](src/icons/icon-128.png)

## 特徴

- **CDJ 風 UI**: 垂直 TEMPO フェーダー、レンジ切替 (±6/±10/±16/WIDE)、TEMPO RESET、MASTER TEMPO ボタン (赤 LED)、緑センター LED
- **DAW 級ピッチキープ**: [Rubber Band Library](https://breakfastquay.com/rubberband/) を WASM で組み込み。MASTER TEMPO ON で音程を保ったままテンポ変更
- **BPM 表示と入力**: 原曲 BPM × 倍率 = 現在 BPM を常時表示。タップ入力 / 自動検知 / Beatport・Traxsource はページから自動取得
- **キーボード / マウスホイール対応**: フェーダー上でホイール、`,` `.` キーでテンポ微調整、`R` リセット、`M` MASTER TEMPO、`T` TAP
- **パネルドラッグ + 位置記憶**: ヘッダーを掴んで好きな位置に移動可能

## 対応サイト

ビルトイン:
- **Bandcamp**
- **Beatport**
- **Traxsource**

その他のサイト: 拡張機能アイコンのポップアップから「+ Add this site」で動的に追加可能 (ユーザー許可必要)。

## インストール

### Chrome / Edge (開発版)

1. `chrome://extensions/` を開く
2. 「デベロッパーモード」を ON
3. 「パッケージ化されていない拡張機能を読み込む」で `src/` ディレクトリを選択

### Firefox (開発版、128 以降)

1. `about:debugging#/runtime/this-firefox` を開く
2. 「一時的なアドオンを読み込む」で `src/manifest.json` を選択

### ストア配布

近日公開予定 (Chrome Web Store / Firefox AMO)。

## キーボードショートカット

| キー | 動作 |
|---|---|
| `,` / `.` | テンポ ±0.1% (Shift で ±1.0%) |
| `R` | TEMPO RESET (0% に戻す) |
| `M` | MASTER TEMPO 切替 |
| `T` | TAP |
| マウスホイール (フェーダー上) | ±0.1% (Shift で ±1.0%) |

入力中フィールドにフォーカスがある時は全て無効化されます。

## アーキテクチャ概要

- **content.js**: パネル UI、フェーダー、BPM 計算、サイト判定
- **page-inject.js** (Beatport / Traxsource): メインワールド注入で `Audio` コンストラクタ・`createBufferSource`・`HTMLMediaElement.play` をモンキーパッチし、DOM 外の音源も捕捉
- **rubberband-worklet.js**: [rubberband-web](https://github.com/delude88/rubberband-web) v0.2.1 を vendor。AudioContext 内で動く WASM ベースの時間伸縮 / ピッチシフター
- **background.js**: ユーザー追加サイトの動的 contentScripts 登録・DNR ルール管理
- **rules.json** (静的) + 動的 DNR: 対応サイトの CSP 除去 (Emscripten の eval 許可) と音声 CDN への CORS ヘッダ付与

## ライセンス

[GPL-2.0](LICENSE) — Rubber Band Library が GPL-2.0-or-later で提供されているため。

## プライバシー

[PRIVACY.md](PRIVACY.md) を参照。データの収集・送信は一切行いません。すべての処理はブラウザ内で完結します。

## 開発 / ビルド

### 必要環境
- bash / zip / git
- (任意) Node.js + npm (rubberband-web の更新時のみ)

### コマンド
```bash
# 拡張機能 ZIP 作成 (ストア提出用)
./scripts/build.sh
# → dist/tempo-slider-X.X.X.zip

# ソースコード ZIP 作成 (Firefox AMO 提出用)
./scripts/build-source.sh
# → dist/tempo-slider-source-X.X.X.zip
```

### Build instructions for AMO reviewers

このアドオンには transpile / 難読化 / minification は使っていません。`src/` 以下のファイルはそのまま実行されます。

`src/rubberband-worklet.js` のみ npm パッケージ [`rubberband-web@0.2.1`](https://www.npmjs.com/package/rubberband-web) からそのまま vendor したファイル (webpack で bundle 済み、Rubber Band Library を WebAssembly に compile したもの)。これは AMO のルールにある "オープンソースのサードパーティライブラリーを除く" の例外に該当します。

該当ファイルを再生成するには:

```bash
npm pack rubberband-web@0.2.1
tar -xzf rubberband-web-0.2.1.tgz
cp package/public/rubberband-processor.js src/rubberband-worklet.js
```

オリジナルの GitHub リポジトリ: https://github.com/delude88/rubberband-web (GPL-2.0-or-later)

検証コマンド:
```bash
sha256sum src/rubberband-worklet.js package/public/rubberband-processor.js
# → 同一ハッシュであることを確認
```
