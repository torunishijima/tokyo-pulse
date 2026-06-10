// =========================================================
// Tokyo Pulse – Netlify Function: train-proxy
// パス: /api/trains
//
// 処理フロー:
//   1. ODPT から都営地下鉄・都電の在線情報を取得
//   2. 駅座標キャッシュを使って fromStation/toStation の中点を算出
//   3. bearing を計算して GeoJSON 形式で返す
// =========================================================

const TOEI_OPERATOR = 'odpt.Operator:Toei';

// Node 18+ のネイティブ fetch にタイムアウトを付与するラッパー
function fetchWithTimeout(url, ms = 10_000) {
  return fetch(url, { signal: AbortSignal.timeout(ms) });
}

// --- レスポンスキャッシュ（同一プロセス内で再利用） ---
let _responseCache = null;
let _responseCacheTime = 0;
const RESPONSE_CACHE_TTL = 15_000; // 15秒

// 路線コード → 日本語名・公式キーカラー
const LINE_INFO = {
  Asakusa:  { name: '浅草線',     color: '#B51C8B' }, // マゼンタ
  Mita:     { name: '三田線',     color: '#0079C2' }, // 青
  Shinjuku: { name: '新宿線',     color: '#6CBB5A' }, // 緑
  Oedo:     { name: '大江戸線',   color: '#EE0011' }, // 赤
  Arakawa:  { name: '都電荒川線', color: '#F5A200' }, // 琥珀
};

const RAIL_DIRECTION_STEP = {
  'odpt.RailDirection:Northbound': 1,
  'odpt.RailDirection:Southbound': -1,
  'odpt.RailDirection:Eastbound': 1,
  'odpt.RailDirection:Westbound': -1,
  'odpt.RailDirection:OuterLoop': 1,
  'odpt.RailDirection:InnerLoop': -1,
  'odpt.RailDirection:Toei.Waseda': 1,
  'odpt.RailDirection:Toei.Minowabashi': -1,
};

// 駅座標キャッシュ（同一プロセス内で再利用）
let _stationCache = null;
let _stationCacheTime = 0;
const STATION_CACHE_TTL = 60 * 60 * 1000; // 1時間

let _railwayOrderCache = null;
let _railwayOrderCacheTime = 0;
const RAILWAY_ORDER_CACHE_TTL = 60 * 60 * 1000; // 1時間

async function fetchStationMap(apiKey) {
  const now = Date.now();
  if (_stationCache && (now - _stationCacheTime) < STATION_CACHE_TTL) {
    return _stationCache;
  }
  const res = await fetchWithTimeout(
    `https://api.odpt.org/api/v4/odpt:Station?odpt:operator=${TOEI_OPERATOR}&acl:consumerKey=${encodeURIComponent(apiKey)}`,
    10_000
  );
  if (!res.ok) throw new Error(`Station fetch error: HTTP ${res.status}`);
  const stations = await res.json();
  const map = new Map();
  for (const s of stations) {
    const id  = s['owl:sameAs'];
    const lat = s['geo:lat'];
    const lon = s['geo:long'];
    const name = s['dc:title'];
    if (id && lat != null && lon != null) map.set(id, { lat, lon, name });
  }
  _stationCache = map;
  _stationCacheTime = now;
  console.log(`[train-proxy] 駅キャッシュ更新: ${map.size}駅`);
  return map;
}

async function fetchRailwayOrderMap(apiKey) {
  const now = Date.now();
  if (_railwayOrderCache && (now - _railwayOrderCacheTime) < RAILWAY_ORDER_CACHE_TTL) {
    return _railwayOrderCache;
  }

  const res = await fetchWithTimeout(
    `https://api.odpt.org/api/v4/odpt:Railway?odpt:operator=${TOEI_OPERATOR}&acl:consumerKey=${encodeURIComponent(apiKey)}`,
    10_000
  );
  if (!res.ok) throw new Error(`Railway fetch error: HTTP ${res.status}`);

  const railways = await res.json();
  const map = new Map();
  for (const railway of railways) {
    const lineCode = railway['owl:sameAs']?.split('.').pop();
    const stationOrder = railway['odpt:stationOrder']?.map(item => item['odpt:station']).filter(Boolean) ?? [];
    if (lineCode && stationOrder.length > 0) {
      map.set(lineCode, stationOrder);
    }
  }

  _railwayOrderCache = map;
  _railwayOrderCacheTime = now;
  console.log(`[train-proxy] 路線駅順キャッシュ更新: ${map.size}路線`);
  return map;
}

function calcBearing(lat1, lon1, lat2, lon2) {
  const toRad = d => d * Math.PI / 180;
  const dLon  = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2))
           - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
  return parseFloat(((Math.atan2(y, x) * 180 / Math.PI + 360) % 360).toFixed(1));
}

function inferToStation(lineCode, fromId, railDirection, railwayOrderMap, destinationStations = []) {
  const step = RAIL_DIRECTION_STEP[railDirection];
  const stationOrder = railwayOrderMap.get(lineCode);
  if (!step || !stationOrder || !fromId) return null;

  const indexes = [];
  stationOrder.forEach((stationId, index) => {
    if (stationId === fromId) indexes.push(index);
  });
  if (indexes.length === 0) return null;

  let index = indexes[0];
  if (indexes.length > 1) {
    const isOedoTochomae = lineCode === 'Oedo' && fromId === 'odpt.Station:Toei.Oedo.Tochomae';
    const headsToHikarigaoka = destinationStations.includes('odpt.Station:Toei.Oedo.Hikarigaoka');

    if (isOedoTochomae && (railDirection === 'odpt.RailDirection:InnerLoop' || headsToHikarigaoka)) {
      index = indexes[indexes.length - 1];
    } else {
      index = step > 0 ? indexes[0] : indexes[indexes.length - 1];
    }
  }
  const nextStationId = stationOrder[index + step];
  if (nextStationId) {
    return { stationId: nextStationId, reverseBearing: false };
  }

  const previousStationId = stationOrder[index - step];
  return previousStationId ? { stationId: previousStationId, reverseBearing: true } : null;
}

exports.handler = async function (event, context) {
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=15, stale-while-revalidate=30',
    'Access-Control-Allow-Origin': '*',
  };

  try {
    const apiKey = process.env.ODPT_API_KEY;
    if (!apiKey || apiKey === 'your_key_here') {
      return { statusCode: 200, headers, body: JSON.stringify({ count: 0, countByLine: {}, trains: [] }) };
    }

    // --- プロセス内キャッシュ: TTL 内なら ODPT を叩かず即返す ---
    const cacheNow = Date.now();
    if (_responseCache && (cacheNow - _responseCacheTime) < RESPONSE_CACHE_TTL) {
      return { statusCode: 200, headers, body: _responseCache };
    }

    const [stationMap, railwayOrderMap, trainRes] = await Promise.all([
      fetchStationMap(apiKey),
      fetchRailwayOrderMap(apiKey),
      fetchWithTimeout(
        `https://api.odpt.org/api/v4/odpt:Train?odpt:operator=${TOEI_OPERATOR}&acl:consumerKey=${encodeURIComponent(apiKey)}`,
        10_000
      ),
    ]);

    if (!trainRes.ok) throw new Error(`Train fetch error: HTTP ${trainRes.status}`);
    const rawTrains = await trainRes.json();

    const trains = [];
    for (const t of rawTrains) {
      const lineCode = t['odpt:railway']?.split('.').pop() ?? 'Unknown';
      const fromId = t['odpt:fromStation'];
      const inferredTo = t['odpt:toStation']
        ? { stationId: t['odpt:toStation'], reverseBearing: false }
        : inferToStation(lineCode, fromId, t['odpt:railDirection'], railwayOrderMap, t['odpt:destinationStation']);
      const toId = inferredTo?.stationId ?? null;
      const from   = fromId ? stationMap.get(fromId) : null;
      const to     = toId   ? stationMap.get(toId)   : null;

      if (!from) continue; // 座標不明はスキップ

      // 位置: from と to の中点（to がない場合は from の位置）
      const lat = to ? (from.lat + to.lat) / 2 : from.lat;
      const lon = to ? (from.lon + to.lon) / 2 : from.lon;
      const bearing = (from && to)
        ? (
            inferredTo?.reverseBearing
              ? calcBearing(to.lat, to.lon, from.lat, from.lon)
              : calcBearing(from.lat, from.lon, to.lat, to.lon)
          )
        : null;

      const lineInfo = LINE_INFO[lineCode] ?? { name: lineCode, color: '#888888' };

      // 遅延（秒 → 分に変換）
      const delayMin = t['odpt:delay'] ? Math.round(t['odpt:delay'] / 60) : 0;

      trains.push({
        id:          t['odpt:trainNumber'],
        line:        lineCode,
        lineName:    lineInfo.name,
        latitude:    parseFloat(lat.toFixed(6)),
        longitude:   parseFloat(lon.toFixed(6)),
        bearing,
        fromStation: from?.name ?? null,
        toStation:   to?.name   ?? null,
        delay:       delayMin,
        trainOwner:  t['odpt:trainOwner']?.split(':').pop() ?? null,
      });
    }

    const countByLine = {};
    for (const tr of trains) {
      countByLine[tr.line] = (countByLine[tr.line] ?? 0) + 1;
    }

    const body = JSON.stringify({
      count: trains.length,
      countByLine,
      timestamp: new Date().toISOString(),
      trains,
    });
    _responseCache = body;
    _responseCacheTime = cacheNow;

    return { statusCode: 200, headers, body };

  } catch (err) {
    console.error('[train-proxy] エラー:', err.message);
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
