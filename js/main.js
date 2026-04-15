// =========================================================
// Tokyo Pulse – メインスクリプト
// 都営バスのリアルタイム位置を地図上にドット表示する
// =========================================================

// --- 定数 ---
const MAP_CENTER = [139.7, 35.68]; // 東京都心
const MAP_ZOOM = 11;
const POLL_INTERVAL_MS = 30_000;   // 30秒ごとに更新
const API_ENDPOINT = '/api/buses';

const SOURCE_ID = 'buses';
const LAYER_ID = 'bus-dots';

// 事業者ごとの色
const OPERATOR_COLOR = {
  toei:  '#4ade80', // 緑
  seibu: '#facc15', // 黄
};

/**
 * バスアイコン（長方形＋後部Vノッチ）の ImageData を生成。
 * bearing=0 で北向き（上＝前）になるよう描画する。
 */
function makeBusIconImageData(color, iw = 22, ih = 44) {
  const canvas = document.createElement('canvas');
  canvas.width  = iw;
  canvas.height = ih;
  const ctx = canvas.getContext('2d');

  // アイコン本体のサイズ（キャンバス内でやや余白を持たせる）
  const pad  = 2;
  const w    = iw - pad * 2;
  const h    = ih - pad * 2;
  const x    = pad;
  const y    = pad;
  const notch = h * 0.22; // 後部Vノッチの深さ

  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x + w / 2, y);              // 前部・先端（上中央）
  ctx.lineTo(x + w,     y + h * 0.28);  // 右肩
  ctx.lineTo(x + w,     y + h);         // 後部・右下
  ctx.lineTo(x + w / 2, y + h - notch); // 後部・中央ノッチ
  ctx.lineTo(x,         y + h);         // 後部・左下
  ctx.lineTo(x,         y + h * 0.28);  // 左肩
  ctx.closePath();
  ctx.fill();

  return ctx.getImageData(0, 0, iw, ih);
}

// --- 地図初期化 ---
const map = new maplibregl.Map({
  container: 'map',
  style: {
    version: 8,
    sources: {
      'osm': {
        type: 'raster',
        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        tileSize: 256,
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxzoom: 19,
      }
    },
    layers: [
      {
        id: 'osm-tiles',
        type: 'raster',
        source: 'osm',
        paint: {
          // 地図を少し暗くして白ドットを見やすくする
          'raster-brightness-max': 0.45,
          'raster-saturation': -0.3,
        }
      }
    ]
  },
  center: MAP_CENTER,
  zoom: MAP_ZOOM,
  attributionControl: false,
});

// 右下にコンパクトなアトリビューション
map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');

// --- 地図ロード後にレイヤーを初期化 ---
map.on('load', () => {
  // 事業者ごとの矢印アイコンを登録
  map.addImage('arrow-toei',  makeBusIconImageData(OPERATOR_COLOR.toei));
  map.addImage('arrow-seibu', makeBusIconImageData(OPERATOR_COLOR.seibu));

  // GeoJSON ソース（空で初期化）
  map.addSource(SOURCE_ID, {
    type: 'geojson',
    data: emptyFeatureCollection(),
  });

  // バス矢印レイヤー（事業者で色分け＋進行方向回転）
  map.addLayer({
    id: LAYER_ID,
    type: 'symbol',
    source: SOURCE_ID,
    layout: {
      'icon-image': [
        'match', ['get', 'operator'],
        'toei',  'arrow-toei',
        'seibu', 'arrow-seibu',
        'arrow-toei', // fallback
      ],
      'icon-rotate':               ['coalesce', ['get', 'bearing'], 0],
      'icon-rotation-alignment':   'map',
      'icon-allow-overlap':        true,
      'icon-ignore-placement':     true,
      'icon-size':                 0.5,
    },
    paint: {
      'icon-opacity': 0.85,
      'icon-opacity-transition': { duration: 600, delay: 0 },
    },
  });

  // --- クリック: ポップアップ表示 ---
  map.on('click', LAYER_ID, (e) => {
    const feature = e.features[0];
    const coords = feature.geometry.coordinates.slice();
    const p = feature.properties;

    popup
      .setLngLat(coords)
      .setHTML(buildPopupHTML(p))
      .addTo(map);
  });

  // --- ホバー: カーソル変更 ---
  map.on('mouseenter', LAYER_ID, () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', LAYER_ID, () => {
    map.getCanvas().style.cursor = '';
  });

  // 初回取得 → その後ポーリング
  fetchAndUpdate();
  setInterval(fetchAndUpdate, POLL_INTERVAL_MS);
});

// --- データ取得 & 地図更新 ---
async function fetchAndUpdate() {
  try {
    const res = await fetch(API_ENDPOINT);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const fc = toFeatureCollection(data.vehicles);

    // フェードアウト → データ差し替え → フェードイン
    map.setPaintProperty(LAYER_ID, 'icon-opacity', 0);
    setTimeout(() => {
      map.getSource(SOURCE_ID).setData(fc);
      map.setPaintProperty(LAYER_ID, 'icon-opacity', 0.85);
    }, 300);

    updateOverlay(data.countByOperator);
  } catch (err) {
    // エラーは静かに無視し、次のポーリングに委ねる
    console.warn('[tokyo-pulse] fetch failed:', err.message);
  }
}

// --- ユーティリティ ---

/** vehicles 配列を GeoJSON FeatureCollection に変換（属性を全てproperitiesに含める） */
function toFeatureCollection(vehicles = []) {
  return {
    type: 'FeatureCollection',
    features: vehicles.map(v => ({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [v.longitude, v.latitude],
      },
      properties: {
        id:           v.id,
        operator:     v.operator     ?? null,
        bearing:      v.bearing      ?? null,
        route:        v.route        ?? null,
        origin:       v.origin       ?? null,
        dest:         v.dest         ?? null,
        nextStop:     v.nextStop     ?? null,
        speed:        v.speed        ?? null,
        status:       v.status       ?? null,
      },
    })),
  };
}

// --- ポップアップ ---
const popup = new maplibregl.Popup({
  closeButton: true,
  closeOnClick: false,
  maxWidth: '280px',
  className: 'bus-popup',
  offset: 8,
});

/** vehicle properties からポップアップ HTML を生成 */
function buildPopupHTML(p) {
  // 区間表示：起終点が両方あれば「A → B」、片方なら省略
  const section = (p.origin && p.dest) ? `${p.origin} → ${p.dest}` : null;

  const rows = [
    ['系統',       p.route    ?? '—'],
    ['区間',       section    ?? '—'],
    ['次の停留所', p.nextStop ?? '—'],
    ['状態',       p.status   ?? '—'],
    ['速度',       p.speed   != null ? `${p.speed} km/h` : '—'],
    ['方位',       p.bearing != null ? `${p.bearing}°` : '—'],
    ['車両ID',     p.id],
  ];

  const tableRows = rows
    .map(([label, val]) => `<tr><th>${label}</th><td>${val}</td></tr>`)
    .join('');

  return `<table class="bus-popup-table">${tableRows}</table>`;
}

/** 空の FeatureCollection */
function emptyFeatureCollection() {
  return { type: 'FeatureCollection', features: [] };
}

/** オーバーレイ（台数・時刻）を更新 */
function updateOverlay(countByOperator = {}) {
  const toei  = countByOperator.toei  ?? '—';
  const seibu = countByOperator.seibu ?? '—';
  document.getElementById('count-toei').textContent  = `都営 ${toei} 台`;
  document.getElementById('count-seibu').textContent = `西武 ${seibu} 台`;
}

// --- 時計（毎秒更新） ---
function tickClock() {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  document.getElementById('clock').textContent = `${hh}:${mm}`;
}
tickClock();
setInterval(tickClock, 1_000);
