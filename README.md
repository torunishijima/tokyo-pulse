# Tokyo Pulse

都営バスのリアルタイム位置情報を地図上にドット表示するWebアプリ。

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

`.env` を編集して ODPT_API_KEY を設定する。
未設定のままでもモックデータで動作確認できる。

### 4. ローカル起動

```bash
cd /path/to/tokyo-pulse
netlify dev
```

→ http://localhost:8888 で確認

## デプロイ

GitHub リポジトリを Netlify に連携済みの場合は push するだけ。
Netlify の環境変数に `ODPT_API_KEY` を設定すること。

## データソース

- [公共交通オープンデータセンター](https://www.odpt.org/)
- エンドポイント: `https://api.odpt.org/api/4/gtfs/realtime/ToeiBus`
- 更新頻度: 30秒

## 拡張について

他のデータソース（鉄道・人流・気象など）を追加する場合:
1. `netlify/functions/` に新しい proxy 関数を追加
2. `js/main.js` に新しい GeoJSON ソース＆レイヤーを追加
