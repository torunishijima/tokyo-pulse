// =========================================================
// Tokyo Pulse – Netlify Function: bus-proxy
// パス: /api/buses
//
// 処理フロー:
//   1. 環境変数から ODPT API キーを取得
//   2. APIキー未設定 → モックデータを返す（開発用）
//   3. ODPT GTFS-RT エンドポイントからバイナリを取得
//   4. Protocol Buffers をパースして JSON に変換
//   5. { count, timestamp, vehicles } 形式で返す
// =========================================================

const { GtfsRealtimeBindings } = require('gtfs-realtime-bindings');
const fetch = require('node-fetch');

const TOEI_ENDPOINT = 'https://api.odpt.org/api/v4/gtfs/realtime/ToeiBus';
const SEIBU_ENDPOINT = 'https://api.odpt.org/api/v4/gtfs/realtime/SeibuBus';

// モック判定：APIキーが未設定 or プレースホルダーのまま
function isMockMode(apiKey) {
  return !apiKey || apiKey === 'your_key_here';
}

// GTFS-RT バイナリを取得してパース → vehicles 配列を返す
async function fetchVehicles(endpoint, apiKey, operator) {
  const url = `${endpoint}?acl:consumerKey=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, { timeout: 10_000 });
  if (!res.ok) throw new Error(`ODPT API error (${operator}): HTTP ${res.status}`);

  const buffer = await res.buffer();
  const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(
    new Uint8Array(buffer)
  );

  const vehicles = [];
  for (const entity of feed.entity) {
    const vp = entity.vehicle;
    if (!vp || !vp.position) continue;

    const { latitude, longitude } = vp.position;
    if (latitude == null || longitude == null) continue;

    const speed = vp.position.speed != null
      ? parseFloat((vp.position.speed * 3.6).toFixed(1))
      : null;
    const bearing = vp.position.bearing != null
      ? parseFloat(vp.position.bearing.toFixed(1))
      : null;
    const statusCode = vp.current_status ?? null;

    vehicles.push({
      id: entity.id,
      operator,
      latitude: parseFloat(latitude.toFixed(6)),
      longitude: parseFloat(longitude.toFixed(6)),
      bearing,
      route:        vp.trip?.route_id ?? null,
      vehicleLabel: vp.vehicle?.label ?? null,
      nextStopId:   vp.stop_id       ?? null,
      nextStop:     null,
      origin:       null,
      dest:         null,
      speed,
      status: statusCode != null ? (STOP_STATUS_LABEL[statusCode] ?? '不明') : null,
    });
  }
  return vehicles;
}

// 東京都内のランダム座標を生成（モック用）
function randomTokyoCoord() {
  return {
    lat: 35.60 + Math.random() * 0.18, // 35.60 〜 35.78
    lon: 139.60 + Math.random() * 0.22, // 139.60 〜 139.82
  };
}

// 都営バスの系統ごとの起終点・途中停留所サンプル（モック用）
// stops: 途中で通過しうる停留所のプール（nextStop の候補）
const MOCK_ROUTE_DATA = [
  { route: '都01', origin: '渋谷駅',     dest: '新橋駅',     stops: ['表参道', '青山一丁目', '赤坂見附', '溜池山王', '虎ノ門'] },
  { route: '都02', origin: '大塚駅前',   dest: '東京駅丸の内', stops: ['春日駅前', '水道橋', '神田橋', '大手町'] },
  { route: '都03', origin: '品川駅前',   dest: '銀座四丁目',  stops: ['高輪台', '白金台', '白金高輪', '芝浦埠頭'] },
  { route: '都04', origin: '東京駅',     dest: '豊洲駅前',    stops: ['築地', '勝どき', '晴海三丁目', '辰巳'] },
  { route: '都05', origin: '晴海埠頭',   dest: '東京駅八重洲', stops: ['勝どき駅前', '豊海町', '八重洲二丁目'] },
  { route: '草41', origin: '浅草寿町',   dest: '浅草橋駅前',  stops: ['田原町', '蔵前橋通り', '三筋'] },
  { route: '草63', origin: '浅草寿町',   dest: '錦糸町駅前',  stops: ['業平橋', '押上', '亀戸'] },
  { route: '草64', origin: '上野公園',   dest: '浅草寿町',    stops: ['下谷三丁目', '三ノ輪', '千住三丁目'] },
  { route: '錦13', origin: '錦糸町駅前', dest: '東陽町駅前',  stops: ['亀戸', '大島', '北砂三丁目'] },
  { route: '錦25', origin: '錦糸町駅前', dest: '晴海三丁目',  stops: ['東陽町', '辰巳', '豊洲市場前'] },
  { route: '橋63', origin: '日本橋',     dest: '亀戸駅前',    stops: ['小伝馬町', '浜町中ノ橋', '森下駅前'] },
  { route: '橋86', origin: '日本橋',     dest: '木場駅前',    stops: ['茅場町', '越中島', '枝川'] },
  { route: '品93', origin: '品川駅前',   dest: '目黒駅前',    stops: ['大崎広小路', '五反田駅前', '不動前'] },
  { route: '品97', origin: '品川駅前',   dest: '大井町駅前',  stops: ['大井競馬場前', '大森駅前'] },
  { route: '品98', origin: '品川駅前',   dest: '等々力',      stops: ['五反田駅', '旗の台', '荏原町'] },
  { route: '渋88', origin: '渋谷駅',     dest: '多摩川駅前',  stops: ['駒沢', '野沢', '尾山台'] },
  { route: '渋41', origin: '渋谷駅',     dest: '代田橋',      stops: ['神泉', '松濤', '大山'] },
  { route: '宿91', origin: '新宿駅西口', dest: '練馬駅前',    stops: ['落合南長崎', '豊玉北', '石神井公園'] },
  { route: '宿74', origin: '新宿駅西口', dest: '荻窪駅北口',  stops: ['中野駅前', '鷺ノ宮', '井荻'] },
  { route: '新宿WE', origin: '新宿駅西口', dest: '晴海埠頭',  stops: ['四谷駅前', '市ヶ谷駅前', '飯田橋'] },
  { route: '新宿FH', origin: '新宿駅西口', dest: '築地',      stops: ['信濃町', '青山一丁目', '六本木'] },
  { route: '門19', origin: '門前仲町',   dest: '東京駅八重洲', stops: ['住吉駅前', '清澄庭園前', '人形町'] },
  { route: '門21', origin: '門前仲町',   dest: '亀戸駅前',    stops: ['木場', '東陽町', '大島'] },
  { route: '王57', origin: '王子駅前',   dest: '錦糸町駅前',  stops: ['梶原', '熊野前', '町屋駅前'] },
  { route: '王40', origin: '王子駅前',   dest: '浅草寿町',    stops: ['飛鳥山', '滝野川一丁目', '西巣鴨'] },
  { route: '東22', origin: '東京駅北口', dest: '南千住駅前',  stops: ['秋葉原', '御徒町', '上野広小路'] },
  { route: '東43', origin: '東京駅北口', dest: '荒川土手',    stops: ['神田', '岩本町', '浜町'] },
];

// VehicleStopStatus コードを日本語に変換
const STOP_STATUS_LABEL = {
  0: '接近中',
  1: '停車中',
  2: '走行中',
};

// 方位角（度）を8方位の文字列に変換
function bearingToCompass(deg) {
  const dirs = ['北', '北東', '東', '南東', '南', '南西', '西', '北西'];
  return dirs[Math.round(deg / 45) % 8];
}

// 西武バスのモック系統データ
const SEIBU_MOCK_ROUTE_DATA = [
  { route: '所11', origin: '所沢駅東口', dest: '小手指駅南口', stops: ['北野', '山口'] },
  { route: '練高01', origin: '練馬高野台駅', dest: '石神井公園駅', stops: ['高野台', '石神井'] },
  { route: '飯01', origin: '飯能駅', dest: '東飯能駅', stops: ['飯能市役所', '市民会館'] },
  { route: '川01', origin: '川越駅東口', dest: '的場', stops: ['平塚', '的場駅'] },
  { route: '志木01', origin: '志木駅南口', dest: '成増駅北口', stops: ['新座', '朝霞台'] },
];

// モックレスポンスを生成
function buildMockResponse() {
  const toeiVehicles = Array.from({ length: 80 }, (_, i) => {
    const { lat, lon } = randomTokyoCoord();
    const speed = parseFloat((Math.random() * 55).toFixed(1));
    const statusCode = [0, 1, 2][Math.floor(Math.random() * 3)];
    const rd = MOCK_ROUTE_DATA[i % MOCK_ROUTE_DATA.length];
    const nextStop = rd.stops[Math.floor(Math.random() * rd.stops.length)];
    return {
      id: `ToeiBus.MOCK${String(i + 1).padStart(3, '0')}`,
      operator: 'toei',
      latitude: parseFloat(lat.toFixed(6)),
      longitude: parseFloat(lon.toFixed(6)),
      bearing: Math.floor(Math.random() * 360),
      route:     rd.route,
      origin:    rd.origin,
      dest:      rd.dest,
      nextStop,
      speed,
      status: STOP_STATUS_LABEL[statusCode] ?? '不明',
    };
  });

  const seibuVehicles = Array.from({ length: 40 }, (_, i) => {
    // 西武バスは西側エリア（練馬・所沢方面）に寄せる
    const lat = 35.70 + Math.random() * 0.15;
    const lon = 139.55 + Math.random() * 0.20;
    const speed = parseFloat((Math.random() * 50).toFixed(1));
    const statusCode = [0, 1, 2][Math.floor(Math.random() * 3)];
    const rd = SEIBU_MOCK_ROUTE_DATA[i % SEIBU_MOCK_ROUTE_DATA.length];
    const nextStop = rd.stops[Math.floor(Math.random() * rd.stops.length)];
    return {
      id: `SeibuBus.MOCK${String(i + 1).padStart(3, '0')}`,
      operator: 'seibu',
      latitude: parseFloat(lat.toFixed(6)),
      longitude: parseFloat(lon.toFixed(6)),
      bearing: Math.floor(Math.random() * 360),
      route:     rd.route,
      origin:    rd.origin,
      dest:      rd.dest,
      nextStop,
      speed,
      status: STOP_STATUS_LABEL[statusCode] ?? '不明',
    };
  });

  const vehicles = [...toeiVehicles, ...seibuVehicles];
  return {
    count: vehicles.length,
    countByOperator: { toei: toeiVehicles.length, seibu: seibuVehicles.length },
    timestamp: new Date().toISOString(),
    vehicles,
    mock: true,
  };
}

exports.handler = async function (event, context) {
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    // 同一オリジンからの呼び出しを許可
    'Access-Control-Allow-Origin': '*',
  };

  try {
    const apiKey = process.env.ODPT_API_KEY;

    // --- モードモード ---
    if (isMockMode(apiKey)) {
      console.log('[bus-proxy] ODPT_API_KEY 未設定 → モックデータを返します');
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify(buildMockResponse()),
      };
    }

    // --- 本番モード: ODPT から並列フェッチ ---
    const [toeiVehicles, seibuVehicles] = await Promise.allSettled([
      fetchVehicles(TOEI_ENDPOINT, apiKey, 'toei'),
      fetchVehicles(SEIBU_ENDPOINT, apiKey, 'seibu'),
    ]).then(results => results.map((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      console.error(`[bus-proxy] フェッチ失敗 (${i === 0 ? 'toei' : 'seibu'}):`, r.reason?.message);
      return [];
    }));

    const vehicles = [...toeiVehicles, ...seibuVehicles];
    const payload = {
      count: vehicles.length,
      countByOperator: { toei: toeiVehicles.length, seibu: seibuVehicles.length },
      timestamp: new Date().toISOString(),
      vehicles,
    };

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(payload),
    };

  } catch (err) {
    console.error('[bus-proxy] エラー:', err.message);
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ error: 'upstream error', message: err.message }),
    };
  }
};
