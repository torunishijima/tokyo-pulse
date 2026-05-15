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
const LAYER_ID  = 'bus-dots';

const TRAIN_SOURCE_ID = 'trains';
const TRAIN_LAYER_ID  = 'train-dots';
const TRAIN_API       = '/api/trains';

let busFetchInFlight = false;
let trainFetchInFlight = false;

// 事業者ごとの色（バス）
const OPERATOR_COLOR = {
  toei:     '#4ade80', // 緑
  seibu:    '#facc15', // 黄
  yokohama: '#f97316', // オレンジ
};

// 路線ごとの色（都営地下鉄・都電）―公式キーカラー
const LINE_COLOR = {
  Asakusa:  '#B51C8B', // 浅草線：マゼンタ
  Mita:     '#0079C2', // 三田線：青
  Shinjuku: '#6CBB5A', // 新宿線：緑
  Oedo:     '#EE0011', // 大江戸線：赤
  Arakawa:  '#F5A200', // 都電荒川線：琥珀
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

  // {width, height, data} 形式で返す（MapLibre addImage が確実に受け付ける形式）
  const imageData = ctx.getImageData(0, 0, iw, ih);
  return { width: iw, height: ih, data: imageData.data };
}

/**
 * 列車アイコン（バスと同形・やや小さめ）の ImageData を生成。
 */
function makeTrainIconImageData(color, iw = 20, ih = 40) {
  const canvas = document.createElement('canvas');
  canvas.width  = iw;
  canvas.height = ih;
  const ctx = canvas.getContext('2d');

  const pad   = 2;
  const w     = iw - pad * 2;
  const h     = ih - pad * 2;
  const x     = pad;
  const y     = pad;
  const notch = h * 0.22;

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

  const imageData = ctx.getImageData(0, 0, iw, ih);
  return { width: iw, height: ih, data: imageData.data };
}

// --- トグル状態 ---
const activeOperators = new Set(['toei', 'seibu', 'yokohama']);
const activeLines     = new Set(Object.keys(LINE_COLOR));

function applyBusFilter() {
  const ops = [...activeOperators];
  map.setFilter(LAYER_ID, ops.length > 0
    ? ['in', ['get', 'operator'], ['literal', ops]]
    : ['==', ['literal', 0], ['literal', 1]]); // 全非表示
}

function applyTrainFilter() {
  const lines = [...activeLines];
  map.setFilter(TRAIN_LAYER_ID, lines.length > 0
    ? ['in', ['get', 'line'], ['literal', lines]]
    : ['==', ['literal', 0], ['literal', 1]]);
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
  map.addImage('arrow-toei',     makeBusIconImageData(OPERATOR_COLOR.toei));
  map.addImage('arrow-seibu',    makeBusIconImageData(OPERATOR_COLOR.seibu));
  map.addImage('arrow-yokohama', makeBusIconImageData(OPERATOR_COLOR.yokohama));

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
        'toei',     'arrow-toei',
        'seibu',    'arrow-seibu',
        'yokohama', 'arrow-yokohama',
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

  // === 列車レイヤー ===
  // 路線ごとの列車アイコンを登録
  Object.entries(LINE_COLOR).forEach(([line, color]) => {
    map.addImage(`train-${line}`, makeTrainIconImageData(color));
  });

  // 列車ソース（空で初期化）
  map.addSource(TRAIN_SOURCE_ID, {
    type: 'geojson',
    data: emptyFeatureCollection(),
  });

  // 列車レイヤー（バスレイヤーの下に描画）
  map.addLayer({
    id: TRAIN_LAYER_ID,
    type: 'symbol',
    source: TRAIN_SOURCE_ID,
    layout: {
      'icon-image': [
        'match', ['get', 'line'],
        'Asakusa',  'train-Asakusa',
        'Mita',     'train-Mita',
        'Shinjuku', 'train-Shinjuku',
        'Oedo',     'train-Oedo',
        'Arakawa',  'train-Arakawa',
        'train-Asakusa',
      ],
      'icon-rotate':             ['coalesce', ['get', 'bearing'], 0],
      'icon-rotation-alignment': 'map',
      'icon-allow-overlap':      true,
      'icon-ignore-placement':   true,
      'icon-size':               0.7,
    },
    paint: {
      'icon-opacity': 0.9,
      'icon-opacity-transition': { duration: 600, delay: 0 },
    },
  }, LAYER_ID); // バスレイヤーの下に挿入

  // 列車クリック
  map.on('click', TRAIN_LAYER_ID, (e) => {
    const p = e.features[0].properties;
    const coords = e.features[0].geometry.coordinates.slice();
    popup.setLngLat(coords).setHTML(buildTrainPopupHTML(p)).addTo(map);
  });
  map.on('mouseenter', TRAIN_LAYER_ID, () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', TRAIN_LAYER_ID, () => { map.getCanvas().style.cursor = ''; });

  // トグルUI初期化（レイヤー追加後に実行）
  initToggles();

  // 初回取得 → その後ポーリング
  fetchAndUpdate();
  fetchAndUpdateTrains();
  setInterval(fetchAndUpdate, POLL_INTERVAL_MS);
  setInterval(fetchAndUpdateTrains, POLL_INTERVAL_MS);
});

// --- データ取得 & 地図更新 ---
async function fetchAndUpdate() {
  if (busFetchInFlight) return;
  busFetchInFlight = true;

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
  } finally {
    busFetchInFlight = false;
  }
}

// --- 列車データ取得 & 地図更新 ---
async function fetchAndUpdateTrains() {
  if (trainFetchInFlight) return;
  trainFetchInFlight = true;

  try {
    const res = await fetch(TRAIN_API);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const fc = toTrainFeatureCollection(data.trains);
    map.setPaintProperty(TRAIN_LAYER_ID, 'icon-opacity', 0);
    setTimeout(() => {
      map.getSource(TRAIN_SOURCE_ID).setData(fc);
      map.setPaintProperty(TRAIN_LAYER_ID, 'icon-opacity', 0.9);
    }, 300);

    updateTrainOverlay(data.countByLine);
  } catch (err) {
    console.warn('[tokyo-pulse] train fetch failed:', err.message);
  } finally {
    trainFetchInFlight = false;
  }
}

/** trains 配列を GeoJSON FeatureCollection に変換 */
function toTrainFeatureCollection(trains = []) {
  return {
    type: 'FeatureCollection',
    features: trains.map(t => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [t.longitude, t.latitude] },
      properties: {
        id:          t.id,
        line:        t.line,
        lineName:    t.lineName,
        bearing:     t.bearing    ?? null,
        fromStation: t.fromStation ?? null,
        toStation:   t.toStation  ?? null,
        delay:       t.delay      ?? 0,
        trainOwner:  t.trainOwner ?? null,
      },
    })),
  };
}

/** 列車ポップアップ HTML を生成 */
function buildTrainPopupHTML(p) {
  const between = (p.fromStation && p.toStation)
    ? `${p.fromStation} → ${p.toStation}`
    : (p.fromStation ?? null);
  const delayStr = p.delay > 0 ? `${p.delay}分遅延` : '定刻';
  const ownerStr = p.trainOwner && p.trainOwner !== 'Toei' ? p.trainOwner : null;

  const rows = [
    ['路線',   p.lineName],
    ['現在地', between],
    ['運行',   delayStr],
    ['車両',   ownerStr ? `(${ownerStr}車)` : null],
    ['列車番号', p.id],
  ];

  return `<table class="bus-popup-table">${renderPopupTableRows(rows)}</table>`;
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
        current:      v.current      ?? null,
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

  // 事業者表示
  const operatorLabel = { toei: '都営バス', seibu: '西武バス', yokohama: '横浜市営バス' }[p.operator] ?? p.operator;

  const rows = [
    ['事業者',     operatorLabel],
    ['系統',       p.route],
    ['区間',       section],
    ['現在地',     p.current],
    ['次の停留所', p.nextStop],
    ['車両ID',     p.id],
  ];

  // 値がある行だけ表示
  return `<table class="bus-popup-table">${renderPopupTableRows(rows)}</table>`;
}

function renderPopupTableRows(rows) {
  return rows
    .filter(([, val]) => val != null && val !== '')
    .map(([label, val]) => `<tr><th>${escapeHTML(label)}</th><td>${escapeHTML(val)}</td></tr>`)
    .join('');
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

/** 空の FeatureCollection */
function emptyFeatureCollection() {
  return { type: 'FeatureCollection', features: [] };
}

/** オーバーレイ（台数・時刻）を更新 */
function updateOverlay(countByOperator = {}) {
  const toei     = countByOperator.toei     ?? '—';
  const seibu    = countByOperator.seibu    ?? '—';
  const yokohama = countByOperator.yokohama ?? '—';
  document.getElementById('count-toei').textContent     = `都営 ${toei} 台`;
  document.getElementById('count-seibu').textContent    = `西武 ${seibu} 台`;
  document.getElementById('count-yokohama').textContent = `横浜市営 ${yokohama} 台`;
}

/** 列車オーバーレイを更新 */
function updateTrainOverlay(countByLine = {}) {
  const total = Object.values(countByLine).reduce((a, b) => a + b, 0);
  document.getElementById('count-trains').textContent = `地下鉄・都電 ${total || '—'} 本`;
}

// --- トグルUI ---
function initToggles() {
  // 列車路線ボタンの色を LINE_COLOR に合わせて設定
  document.querySelectorAll('.train-toggle').forEach(el => {
    el.style.color = LINE_COLOR[el.dataset.line] ?? '#fff';
  });

  // バス事業者トグル
  document.querySelectorAll('#bus-count .toggle-btn').forEach(el => {
    el.addEventListener('click', () => {
      const key = el.dataset.key;
      if (activeOperators.has(key)) {
        activeOperators.delete(key);
        el.classList.add('off');
      } else {
        activeOperators.add(key);
        el.classList.remove('off');
      }
      applyBusFilter();
    });
  });

  // 列車路線トグル
  document.querySelectorAll('.train-toggle').forEach(el => {
    el.addEventListener('click', () => {
      const line = el.dataset.line;
      if (activeLines.has(line)) {
        activeLines.delete(line);
        el.classList.add('off');
      } else {
        activeLines.add(line);
        el.classList.remove('off');
      }
      applyTrainFilter();
    });
  });
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
