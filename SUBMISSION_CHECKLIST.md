# Submission Checklist

ストア提出のための準備物チェックリスト。

## ✅ 完了済み

- [x] ソースコード (GitHub)
- [x] LICENSE (GPL-2.0)
- [x] README.md
- [x] PRIVACY.md
- [x] docs/index.html, docs/privacy.html (GitHub Pages 用)
- [x] STORE_LISTING.md (説明文・権限理由)
- [x] scripts/build.sh (ZIP パッケージ作成)
- [x] アイコン (16/32/48/128 PNG)

## ⬜ あなたの作業 (手動)

### 1. GitHub Pages を有効化

リポジトリの Settings → Pages:
- Source: `Deploy from a branch`
- Branch: `main` / `/docs` フォルダを選択
- 数分後に https://xtal-jp.github.io/tempo-slider/ で公開される
- プライバシーポリシー URL: https://xtal-jp.github.io/tempo-slider/privacy.html

### 2. スクリーンショット撮影 (1280x800 推奨)

Chrome Web Store は最大 5 枚、最低 1 枚。撮るべきもの:

1. **メインデモ**: Bandcamp トラックページで TEMPO Slider パネル表示中、MASTER TEMPO ON、フェーダー +5%、Original/Current BPM 表示あり
2. **Beatport で動作**: Beatport トラックページで原曲 BPM が自動取得されている様子
3. **Traxsource で動作**: 同上
4. **キーボードショートカット表示**: パネル下部のショートカット早見表が見える状態
5. **Popup**: 拡張機能アイコンクリックで「+ Add this site」UI が見える状態

撮影のコツ:
- macOS: `Cmd+Shift+4` でエリア選択スクショ。ブラウザを 1280x800 に縮めて全体を撮ると Web Store にちょうど良い
- ブラウザ UI は最小限に (タブバーと URL バーだけ)
- パネルが見やすい位置に配置 (右下デフォルトのまま、または中央あたり)

### 3. プロモーション画像 (Chrome Web Store)

#### Small promo tile: 440×280 (必須)
- 黒〜濃灰の背景
- 左にアイコン (icon-128.png を 180×180 程度に拡大)
- 右に "TEMPO Slider" タイトル + サブテキスト
- 推奨ツール: [Canva](https://canva.com), Figma, または ImageMagick

#### Large promo image: 920×680 (任意、おすすめ)
- パネルのスクリーンショットを背景に
- 拡張機能ロゴ + キャッチコピー

#### Marquee: 1400×560 (任意、Featured 枠で使われる)
- 横長レイアウト

### 4. Chrome Web Store 開発者登録 + 提出

1. https://chrome.google.com/webstore/devconsole/ で登録
2. $5 の開発者料金を支払い (一回限り)
3. New item → ZIP (`dist/tempo-slider-0.6.0.zip`) をアップロード
4. ストア掲載情報を入力 (STORE_LISTING.md からコピペ)
5. プライバシー → permission justification を入力
6. プライバシーポリシー URL を入力
7. 公開範囲を設定 (Public 推奨)
8. 提出 → 審査 (通常 1-3 営業日)

### 5. Firefox AMO 開発者登録 + 提出

1. https://addons.mozilla.org/developers/ で登録 (無料)
2. Submit new add-on → ZIP をアップロード
3. 配布方法: AMO 経由 (推奨) or 自己ホスト
4. ストア掲載情報を入力
5. 提出 → 審査 (通常 数日)

## ⬜ ZIP パッケージ作成

```bash
./scripts/build.sh
# → dist/tempo-slider-0.6.0.zip が生成される
```

## ⬜ 提出後のリリース運用

- バグレポートは GitHub Issues で受ける
- アップデートは `version` を上げて新しい ZIP を提出
- `optional_host_permissions` のおかげで、新サイト追加は popup から動的に可能 (ユーザーが許可するだけ)
- 大規模な変更は更新時に「リリースノート」を書くと審査がスムーズ
