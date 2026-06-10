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
 * 進行方向を示す矢印型アイコン（長方形＋後部Vノッチ）の ImageData を生成。
 * bearing=0 で北向き（上＝前）になるよう描画する。
 * バス・列車で共通利用（サイズだけ変える）。
 */
function makeArrowIconImageData(color, iw = 22, ih = 44) {
  const canvas = document.createElement('canvas');
  canvas.width  = iw;
  canvas.height = ih;
  const ctx = canvas.getContext('2d');

  // アイコン本体のサイズ（キャンバス内でやや余白を持たせる）
  const pad   = 2;
  const w     = iw - pad * 2;
  const h     = ih - pad * 2;
  const x     = pad;
  const y     = pad;
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

// --- なめらか移動アニメーション ---
// 前回の描画位置から新しい目標位置へ数フレームかけて補間し、
// 車両が「走っている」ように見せる（30秒ごとのワープを解消）。
const MOVE_DURATION_MS = 1400;

function easeInOutQuad(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

function makeAnimator(sourceId) {
  const rendered = new Map(); // id -> [lng, lat] 現在表示中の座標
  let raf = null;

  return function update(featureCollection) {
    const targets = featureCollection.features;
    // 各 feature の開始位置 = 直近の描画位置（無ければ目標位置 = 新規出現）
    const from = new Map();
    for (const f of targets) {
      const id = f.properties.id;
      from.set(id, rendered.get(id) ?? f.geometry.coordinates.slice());
    }

    const start = performance.now();
    if (raf) cancelAnimationFrame(raf);

    function frame(now) {
      const t = Math.min((now - start) / MOVE_DURATION_MS, 1);
      const e = easeInOutQuad(t);
      const liveIds = new Set();

      const features = targets.map(f => {
        const id = f.properties.id;
        liveIds.add(id);
        const a = from.get(id);
        const b = f.geometry.coordinates;
        const lng = a[0] + (b[0] - a[0]) * e;
        const lat = a[1] + (b[1] - a[1]) * e;
        rendered.set(id, [lng, lat]);
        return { type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: f.properties };
      });

      // 今回データに存在しない車両は描画記録から除去
      for (const id of rendered.keys()) {
        if (!liveIds.has(id)) rendered.delete(id);
      }

      const src = map.getSource(sourceId);
      if (src) src.setData({ type: 'FeatureCollection', features });

      raf = t < 1 ? requestAnimationFrame(frame) : null;
    }
    raf = requestAnimationFrame(frame);
  };
}

let animateBuses  = null;
let animateTrains = null;

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
  map.addImage('arrow-toei',     makeArrowIconImageData(OPERATOR_COLOR.toei));
  map.addImage('arrow-seibu',    makeArrowIconImageData(OPERATOR_COLOR.seibu));
  map.addImage('arrow-yokohama', makeArrowIconImageData(OPERATOR_COLOR.yokohama));

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
  // 路線ごとの列車アイコンを登録（バスよりやや小さめ）
  Object.entries(LINE_COLOR).forEach(([line, color]) => {
    map.addImage(`train-${line}`, makeArrowIconImageData(color, 20, 40));
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

  // アニメーターをソースに紐付け
  animateBuses  = makeAnimator(SOURCE_ID);
  animateTrains = makeAnimator(TRAIN_SOURCE_ID);

  // 初回取得 → その後ポーリング（タブ可視時のみ動作）
  fetchAndUpdate();
  fetchAndUpdateTrains();
  startPolling();
});

// --- 接続状態 & データ鮮度の表示 ---
let dataTimestamp = null;   // サーバーが返したデータの生成時刻
let currentMode  = 'updating';
let busOk = true;
let trainOk = true;

// 複数ソースのうち最新のデータ時刻を採用
function noteDataTimestamp(iso) {
  const ts = new Date(iso);
  if (!dataTimestamp || ts > dataTimestamp) dataTimestamp = ts;
}

// 経過時間を「N秒前 / N分前」に整形
function formatAge(date) {
  const sec = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (sec < 60) return `${sec}秒前`;
  const min = Math.floor(sec / 60);
  return `${min}分前`;
}

function renderStatusText() {
  const text = document.getElementById('status-text');
  if (currentMode === 'updating') {
    text.textContent = '更新中…';
  } else if (currentMode === 'error') {
    text.textContent = '接続エラー';
  } else if (dataTimestamp) {
    text.textContent = `${formatAge(dataTimestamp)}更新`;
  } else {
    text.textContent = 'ライブ';
  }
}

function setStatus(mode) {
  currentMode = mode;
  document.getElementById('status').className = mode;
  renderStatusText();
}

function reportFetchResult() {
  setStatus((busOk || trainOk) ? 'live' : 'error');
}

// --- ポーリング制御（タブ非表示中は停止してクォータ・電池を節約） ---
let busTimer = null;
let trainTimer = null;

function startPolling() {
  stopPolling();
  busTimer   = setInterval(fetchAndUpdate, POLL_INTERVAL_MS);
  trainTimer = setInterval(fetchAndUpdateTrains, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (busTimer)   { clearInterval(busTimer);   busTimer = null; }
  if (trainTimer) { clearInterval(trainTimer); trainTimer = null; }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopPolling();
  } else {
    // 復帰時：即時更新してからポーリング再開
    fetchAndUpdate();
    fetchAndUpdateTrains();
    startPolling();
  }
});

// --- データ取得 & 地図更新 ---
async function fetchAndUpdate() {
  if (busFetchInFlight) return;
  busFetchInFlight = true;
  setStatus('updating');

  try {
    const res = await fetch(API_ENDPOINT);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const fc = toFeatureCollection(data.vehicles);

    // 前回位置 → 新位置へなめらかに移動
    if (animateBuses) animateBuses(fc);
    else map.getSource(SOURCE_ID).setData(fc);

    if (data.timestamp) noteDataTimestamp(data.timestamp);
    updateOverlay(data.countByOperator);
    busOk = true;
  } catch (err) {
    console.warn('[tokyo-pulse] fetch failed:', err.message);
    busOk = false;
  } finally {
    busFetchInFlight = false;
    reportFetchResult();
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

    // 前回位置 → 新位置へなめらかに移動
    if (animateTrains) animateTrains(fc);
    else map.getSource(TRAIN_SOURCE_ID).setData(fc);

    if (data.timestamp) noteDataTimestamp(data.timestamp);
    updateTrainOverlay(data.countByLine);
    trainOk = true;
  } catch (err) {
    console.warn('[tokyo-pulse] train fetch failed:', err.message);
    trainOk = false;
  } finally {
    trainFetchInFlight = false;
    reportFetchResult();
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
      const on = !activeOperators.has(key);
      on ? activeOperators.add(key) : activeOperators.delete(key);
      el.classList.toggle('off', !on);
      el.setAttribute('aria-pressed', String(on));
      applyBusFilter();
    });
  });

  // 列車路線トグル
  document.querySelectorAll('.train-toggle').forEach(el => {
    el.addEventListener('click', () => {
      const line = el.dataset.line;
      const on = !activeLines.has(line);
      on ? activeLines.add(line) : activeLines.delete(line);
      el.classList.toggle('off', !on);
      el.setAttribute('aria-pressed', String(on));
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
  // データ鮮度の「N秒前」表示も毎秒更新する
  if (currentMode === 'live') renderStatusText();
}
tickClock();
setInterval(tickClock, 1_000);

// --- パネル折りたたみ ---
document.getElementById('collapse-btn').addEventListener('click', () => {
  const overlay = document.getElementById('overlay');
  const btn = document.getElementById('collapse-btn');
  const collapsed = overlay.classList.toggle('collapsed');
  btn.textContent = collapsed ? '+' : '−';
  btn.title = collapsed ? 'パネルを開く' : 'パネルを折りたたむ';
});

// --- 手動更新 ---
document.getElementById('refresh-btn').addEventListener('click', async () => {
  const btn = document.getElementById('refresh-btn');
  btn.classList.add('spinning');
  await Promise.allSettled([fetchAndUpdate(), fetchAndUpdateTrains()]);
  btn.classList.remove('spinning');
});

// --- 現在地へ移動 ---
document.getElementById('locate-btn').addEventListener('click', () => {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    pos => {
      map.flyTo({
        center: [pos.coords.longitude, pos.coords.latitude],
        zoom: 14,
        duration: 1_200,
      });
    },
    err => console.warn('[tokyo-pulse] geolocation failed:', err.message),
    { enableHighAccuracy: false, timeout: 8_000 }
  );
});
