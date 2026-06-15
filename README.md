# Tokyo Pulse

東京の公共交通のリアルタイム位置情報を地図上に表示する Web アプリ。

- 🚌 **バス**: 都営バス・西武バス・横浜市営バス
- 🚇 **鉄軌道**: 都営地下鉄（浅草・三田・新宿・大江戸）・都電荒川線

車両は進行方向に向いた矢印で描画され、更新ごとに前回位置から新位置へ
なめらかに移動します。アイコンをタップすると系統・区間・遅延などの詳細を表示します。

## 主な機能

- 事業者 / 路線ごとの**表示トグル**（凡例をタップで ON/OFF）
- **接続状態インジケーター**（ライブ / 更新中 / エラー）とデータ鮮度（「N秒前更新」）
- **手動更新**・**現在地へ移動**ボタン
- パネルの**折りたたみ**（スマホで地図を広く使える）
- **PWA 対応**: ホーム画面に追加してオフライン起動可能
- タブ非表示中はポーリングを停止し、API クォータと電池を節約
- おまけ: `game.html`（Tokyo Rush ミニゲーム）

## セットアップ

### 1. Netlify CLI インストール

```bash
npm install -g netlify-cli
```

### 2. Functions の依存パッケージをインストール

```bash
cd netlify/functions
npm install
```

### 3. APIキー設定

`.env` を編集して `ODPT_API_KEY` を設定する。
未設定のままでもモックデータで動作確認できる（バスのみ）。

### 4. ローカル起動

```bash
cd /path/to/tokyo-pulse
netlify dev
```

→ http://localhost:8888 で確認

## デプロイ

GitHub リポジトリを Netlify に連携済みの場合は push するだけ。
Netlify の環境変数に `ODPT_API_KEY` を設定すること。

## 構成

| パス | 役割 |
|------|------|
| `index.html` / `style.css` / `js/main.js` | フロントエンド（地図・UI・アニメーション） |
| `netlify/functions/buses.js` | `/api/buses` プロキシ（GTFS-RT + REST をマージ） |
| `netlify/functions/trains.js` | `/api/trains` プロキシ（在線情報 → 駅間中点を算出） |
| `manifest.webmanifest` / `sw.js` / `icon.svg` | PWA（マニフェスト・Service Worker・アイコン） |

サーバー側はネイティブ `fetch`（Node 18+）を使用し、ODPT への負荷を抑えるため
レスポンスを 15 秒間キャッシュする（`netlify.toml` で `NODE_VERSION=20` を指定）。

## データソース

- [公共交通オープンデータセンター (ODPT)](https://www.odpt.org/)
- バス: GTFS-RT（都営）+ `odpt:Bus` REST（全社）
- 鉄軌道: `odpt:Train` / `odpt:Station` / `odpt:Railway`
- 更新頻度: クライアント 30秒ポーリング / サーバー 15秒キャッシュ

## 拡張について

他のデータソース（鉄道・人流・気象など）を追加する場合:
1. `netlify/functions/` に新しい proxy 関数を追加
2. `js/main.js` に新しい GeoJSON ソース＆レイヤーを追加（`makeAnimator` で滑らか移動も流用可）
