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

const { transit_realtime } = require('gtfs-realtime-bindings');
const fetch = require('node-fetch');

const TOEI_ENDPOINT = 'https://api.odpt.org/api/v4/gtfs/realtime/ToeiBus';

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
  const feed = transit_realtime.FeedMessage.decode(
    new Uint8Array(buffer)
  );

  const vehicles = [];
  for (const entity of feed.entity) {
    const vp = entity.vehicle;
    if (!vp || !vp.position) continue;

    const { latitude, longitude } = vp.position;
    if (latitude == null || longitude == null) continue;

    // protobuf.js は未設定の optional float を 0 で返す → 0 は「未提供」として null 扱い
    const rawSpeed   = vp.position.speed;
    const rawBearing = vp.position.bearing;
    const speed   = (rawSpeed   != null && rawSpeed   !== 0)
      ? parseFloat((rawSpeed * 3.6).toFixed(1))
      : null;
    const bearing = (rawBearing != null && rawBearing !== 0)
      ? parseFloat(rawBearing.toFixed(1))
      : null;
    const statusCode = vp.current_status ?? null;

    vehicles.push({
      id: entity.id,
      operator,
      latitude: parseFloat(latitude.toFixed(6)),
      longitude: parseFloat(longitude.toFixed(6)),
      bearing,
      route:        null,
      vehicleLabel: vp.vehicle?.label ?? entity.id,
      nextStop:     null,
      origin:       null,
      dest:         null,
      current:      null,
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

// ===== バス停座標キャッシュ（同一プロセス内で再利用） =====
let _busStopCache = null;
let _busStopCacheTime = 0;
const BUS_STOP_CACHE_TTL = 60 * 60 * 1000; // 1時間

// BusstopPole 全件取得 → poleId → {lat, lon, name} の Map を返す（複数事業者を並列取得）
async function fetchBusStopMap(apiKey) {
  const now = Date.now();
  if (_busStopCache && (now - _busStopCacheTime) < BUS_STOP_CACHE_TTL) {
    return _busStopCache;
  }
  try {
    const operators = ['odpt.Operator:Toei', 'odpt.Operator:YokohamaMunicipal'];
    const allPoles = await Promise.all(operators.map(op =>
      fetch(`https://api.odpt.org/api/v4/odpt:BusstopPole?odpt:operator=${op}&acl:consumerKey=${encodeURIComponent(apiKey)}`, { timeout: 15_000 })
        .then(r => r.ok ? r.json() : []).catch(() => [])
    ));
    const map = new Map();
    for (const poles of allPoles) {
      for (const p of poles) {
        const id = p['owl:sameAs'];
        const lat = p['geo:lat'];
        const lon = p['geo:long'];
        const name = p['dc:title'] ?? p['odpt:note'] ?? null;
        if (id && lat != null && lon != null) map.set(id, { lat, lon, name });
      }
    }
    _busStopCache = map;
    _busStopCacheTime = now;
    console.log(`[bus-proxy] BusstopPole キャッシュ更新: ${map.size}件`);
    return map;
  } catch (err) {
    console.warn('[bus-proxy] BusstopPole フェッチ失敗:', err.message);
    return _busStopCache ?? new Map();
  }
}

// 2点間の方位角（0〜360°、北=0）を計算
function calcBearing(lat1, lon1, lat2, lon2) {
  const toRad = d => d * Math.PI / 180;
  const dLon  = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2))
          - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
  return parseFloat(((Math.atan2(y, x) * 180 / Math.PI + 360) % 360).toFixed(1));
}

// ODPT REST API から odpt:Bus 詳細を取得 → busNumber → データ の Map を返す
async function fetchRestBusMap(apiKey, operatorId) {
  const url = `https://api.odpt.org/api/v4/odpt:Bus?odpt:operator=${operatorId}&acl:consumerKey=${encodeURIComponent(apiKey)}`;
  try {
    const res = await fetch(url, { timeout: 10_000 });
    if (!res.ok) {
      console.warn(`[bus-proxy] REST API エラー (${operatorId}): HTTP ${res.status}`);
      return new Map();
    }
    const buses = await res.json();
    const map = new Map();
    for (const bus of buses) {
      const num = bus['odpt:busNumber'];
      if (num) map.set(num, bus);
    }
    return map;
  } catch (err) {
    console.warn(`[bus-proxy] REST API フェッチ失敗 (${operatorId}):`, err.message);
    return new Map();
  }
}

// odpt:note を解析して系統・区間・現在地を抽出
// パターン1: "都０１（Ｔ０１） 渋谷駅前→新橋駅前 六本木駅前"
// パターン2: "ＲＨ０１ 渋谷駅前→六本木ヒルズ 南青山七丁目"  ← （）なし
function parseOdptNote(note) {
  if (!note) return {};
  // {系統情報} {起点}→{終点} {現在地} という形式（スペースを区切りに使用）
  const m = note.match(/^(.+?)\s+(.+?)→(.+?)\s+(.+)$/);
  if (!m) return {};
  return {
    route:   m[1].trim(),  // "都０１（Ｔ０１）" or "ＲＨ０１"
    origin:  m[2].trim(),  // "渋谷駅前"
    dest:    m[3].trim(),  // "新橋駅前"
    current: m[4].trim(),  // "六本木駅前"（直近の停留所エリア）
  };
}

// GTFS-RT vehicles に REST API データと bearing をマージ
function mergeRestData(vehicles, restMap, stopMap) {
  return vehicles.map(v => {
    const detail = restMap.get(v.vehicleLabel);
    if (!detail) return v;
    const parsed = parseOdptNote(detail['odpt:note']);

    // fromBusstopPole → toBusstopPole の座標差から bearing を計算
    let bearing = v.bearing; // GTFS-RT 提供値（通常 null）
    const toStop = stopMap ? stopMap.get(detail['odpt:toBusstopPole']) : null;
    if (bearing == null && stopMap) {
      const from = stopMap.get(detail['odpt:fromBusstopPole']);
      if (from && toStop) bearing = calcBearing(from.lat, from.lon, toStop.lat, toStop.lon);
    }

    return {
      ...v,
      bearing,
      route:    parsed.route   ?? null,
      origin:   parsed.origin  ?? null,
      dest:     parsed.dest    ?? null,
      current:  parsed.current ?? null,
      nextStop: toStop?.name   ?? null,
    };
  });
}

// 西武バス note パース: "busNo:section:patternId:dir:current:nextStop"
// 例: "493:成増駅南口〜光が丘駅:1013:2:光が丘ＩＭＡ:光が丘駅"
function parseSeibuNote(note) {
  if (!note) return {};
  const parts = note.split(':');
  if (parts.length < 6) return {};
  const section = parts[1].trim();

  let origin = null, dest = null;
  if (section.includes('〜')) {
    [origin, dest] = section.split('〜').map(s => s.trim());
  } else if (section.includes('→')) {
    const segs = section.split('→').map(s => s.trim());
    origin = segs[0];
    dest   = segs[segs.length - 1];
  } else {
    // "荻窪駅（上井草）石神井公園駅" のような形式
    const m = section.match(/^(.+?)（.+?）(.+)$/);
    if (m) { origin = m[1].trim(); dest = m[2].trim(); }
  }

  return {
    origin,
    dest,
    current:  parts[4].trim() || null,
    nextStop: parts[5].trim() || null,
  };
}

// 西武バス REST odpt:Bus から vehicles 配列を生成
async function fetchSeibuRestVehicles(apiKey) {
  const url = `https://api.odpt.org/api/v4/odpt:Bus?odpt:operator=odpt.Operator:SeibuBus&acl:consumerKey=${encodeURIComponent(apiKey)}`;
  try {
    const res = await fetch(url, { timeout: 10_000 });
    if (!res.ok) {
      console.warn(`[bus-proxy] SeibuBus REST エラー: HTTP ${res.status}`);
      return [];
    }
    const buses = await res.json();
    return buses
      .filter(b => b['geo:lat'] != null && b['geo:long'] != null)
      .map(b => {
        const noteInfo = parseSeibuNote(b['odpt:note']);
        return {
          id:           b['odpt:busNumber'] ?? b['owl:sameAs'],
          operator:     'seibu',
          latitude:     parseFloat(b['geo:lat'].toFixed(6)),
          longitude:    parseFloat(b['geo:long'].toFixed(6)),
          bearing:      b['odpt:azimuth'] ?? null,
          vehicleLabel: b['odpt:busNumber'],
          route:        null,           // ローマ字系統コードは表示しない
          origin:       noteInfo.origin   ?? null,
          dest:         noteInfo.dest     ?? null,
          current:      noteInfo.current  ?? null,
          nextStop:     noteInfo.nextStop ?? null,
          speed:        null,
          status:       null,
        };
      });
  } catch (err) {
    console.warn('[bus-proxy] SeibuBus REST フェッチ失敗:', err.message);
    return [];
  }
}

// 横浜市営バス REST odpt:Bus から vehicles 配列を生成
async function fetchYokohamaRestVehicles(apiKey, stopMap) {
  const url = `https://api.odpt.org/api/v4/odpt:Bus?odpt:operator=odpt.Operator:YokohamaMunicipal&acl:consumerKey=${encodeURIComponent(apiKey)}`;
  try {
    const res = await fetch(url, { timeout: 10_000 });
    if (!res.ok) {
      console.warn(`[bus-proxy] YokohamaMunicipal REST エラー: HTTP ${res.status}`);
      return [];
    }
    const buses = await res.json();
    return buses
      .filter(b => b['geo:lat'] != null && b['geo:long'] != null)
      .map(b => {
        // 系統番号を busroute から抽出: "odpt.Busroute:YokohamaMunicipal.065" → "65系"
        const routeRaw = b['odpt:busroute'] ?? '';
        const routeNum = routeRaw.split('.').pop();
        const route = routeNum ? `${parseInt(routeNum, 10)}系` : null;

        // stopMap から停留所名を引く
        const origin   = stopMap?.get(b['odpt:startingBusstopPole'])?.name ?? null;
        const dest     = stopMap?.get(b['odpt:terminalBusstopPole'])?.name  ?? null;
        const current  = stopMap?.get(b['odpt:fromBusstopPole'])?.name      ?? null;
        const nextStop = stopMap?.get(b['odpt:toBusstopPole'])?.name         ?? null;

        return {
          id:           b['odpt:busNumber'] ?? b['owl:sameAs'],
          operator:     'yokohama',
          latitude:     parseFloat(b['geo:lat'].toFixed(6)),
          longitude:    parseFloat(b['geo:long'].toFixed(6)),
          bearing:      b['odpt:azimuth'] != null ? parseFloat(b['odpt:azimuth'].toFixed(1)) : null,
          vehicleLabel: b['odpt:busNumber'],
          route,
          origin,
          dest,
          current,
          nextStop,
          speed:  null,
          status: null,
        };
      });
  } catch (err) {
    console.warn('[bus-proxy] YokohamaMunicipal REST フェッチ失敗:', err.message);
    return [];
  }
}

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

const YOKOHAMA_MOCK_ROUTE_DATA = [
  { route: '8系', origin: '横浜駅前', dest: '本牧車庫前', stops: ['桜木町駅前', '中華街入口', '本牧宮原'] },
  { route: '26系', origin: '横浜駅前', dest: '海づり桟橋', stops: ['山下ふ頭入口', '本牧ふ頭入口', '港湾カレッジ前'] },
  { route: '58系', origin: '桜木町駅前', dest: '磯子駅前', stops: ['麦田町', '根岸駅前', '八幡橋'] },
  { route: '65系', origin: '横浜駅西口', dest: '港南台駅前', stops: ['保土ケ谷駅東口', '上大岡駅前', '清水橋'] },
  { route: '101系', origin: '根岸駅前', dest: '保土ケ谷車庫前', stops: ['元町', '桜木町駅前', '洪福寺'] },
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

  const yokohamaVehicles = Array.from({ length: 30 }, (_, i) => {
    // 横浜市営バスは横浜中心部から南側に寄せる
    const lat = 35.38 + Math.random() * 0.12;
    const lon = 139.55 + Math.random() * 0.14;
    const rd = YOKOHAMA_MOCK_ROUTE_DATA[i % YOKOHAMA_MOCK_ROUTE_DATA.length];
    const current = rd.stops[Math.floor(Math.random() * rd.stops.length)];
    const nextStop = rd.stops[Math.floor(Math.random() * rd.stops.length)];
    return {
      id: `YokohamaMunicipal.MOCK${String(i + 1).padStart(3, '0')}`,
      operator: 'yokohama',
      latitude: parseFloat(lat.toFixed(6)),
      longitude: parseFloat(lon.toFixed(6)),
      bearing: Math.floor(Math.random() * 360),
      route: rd.route,
      origin: rd.origin,
      dest: rd.dest,
      current,
      nextStop,
      speed: null,
      status: null,
    };
  });

  const vehicles = [...toeiVehicles, ...seibuVehicles, ...yokohamaVehicles];
  return {
    count: vehicles.length,
    countByOperator: {
      toei: toeiVehicles.length,
      seibu: seibuVehicles.length,
      yokohama: yokohamaVehicles.length,
    },
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

    // --- モックモード ---
    if (isMockMode(apiKey)) {
      console.log('[bus-proxy] ODPT_API_KEY 未設定 → モックデータを返します');
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify(buildMockResponse()),
      };
    }

    // --- 本番モード: GTFS-RT(都営) + REST API(全社) + BusstopPole を並列フェッチ ---
    // 横浜市営は stopMap が必要なので先に取得
    const [toeiGtfs, toeiRestMap, busStopMap, seibuVehicles] = await Promise.all([
      fetchVehicles(TOEI_ENDPOINT, apiKey, 'toei').catch(err => {
        console.error('[bus-proxy] ToeiBus GTFS-RT 失敗:', err.message);
        return [];
      }),
      fetchRestBusMap(apiKey, 'odpt.Operator:Toei'),
      fetchBusStopMap(apiKey),
      fetchSeibuRestVehicles(apiKey),
    ]);

    const yokohamaVehicles = await fetchYokohamaRestVehicles(apiKey, busStopMap);

    // 都営: GTFS-RT + REST API（系統・停留所・bearing）をマージ
    const toeiVehicles = mergeRestData(toeiGtfs, toeiRestMap, busStopMap);

    const vehicles = [...toeiVehicles, ...seibuVehicles, ...yokohamaVehicles];
    const payload = {
      count: vehicles.length,
      countByOperator: { toei: toeiVehicles.length, seibu: seibuVehicles.length, yokohama: yokohamaVehicles.length },
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
