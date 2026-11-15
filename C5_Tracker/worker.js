// C-5 Tracker Worker  ·  v2 (50 tails: Travis, Dover, Westover, Kelly/Lackland)
// Cron (every 5 min) polls public ADS-B feeds for the 16 tails and stores one
// shared "database" in KV (key: fleet-cache). Every site reads it via ?fleet=1.
//
// Cache shape (one KV key, written once per cron run):
//   { "<hex>": { ac: {...latest raw aircraft...}, cachedAt: <ms>, history: [ {lat,lon,alt,gs,g,ts}, ... ] } }
//   alt = feet (0 when on the ground), gs = knots, g = 1 when the transponder reports "ground"

const AIRCRAFT_HEXES = [
  // Travis AFB (16)
  'ae051a','ae051d','ae055b','ae055d','ae0567','ae0568','ae056d','ae0570',
  'ae0575','ae0577','ae0579','ae057a','ae057b','ae057d','ae0587','ae0589',
  // Dover AFB (19)
  'ae053e','ae0559','ae055c','ae055e','ae055f','ae0560','ae0561','ae0562','ae0564','ae0565',
  'ae056a','ae056c','ae056e','ae0571','ae0576','ae0580','ae0581','ae0585','ae058a',
  // Westover ARB (8)
  'ae0569','ae056b','ae0578','ae057c','ae057e','ae0582','ae0584','ae0586',
  // Kelly Field / JBSA-Lackland (7)
  'ae0563','ae0566','ae056f','ae0572','ae0574','ae0583','ae0588',
];

// Tried in order. Each entry: base URL + the path words that source uses.
const SOURCES = [
  { base: 'https://opendata.adsb.fi/api/v2', cs: 'callsign', reg: 'registration' },
  { base: 'https://api.adsb.lol/v2',          cs: 'callsign', reg: 'reg' },
  { base: 'http://api.airplanes.live/v2',     cs: 'callsign', reg: 'reg' },
];

const CACHE_KEY   = 'fleet-cache';
const MAX_AGE_MS  = 7 * 24 * 3600 * 1000; // keep 7 days of history
const MAX_POINTS  = 2016;                 // 7 days at one point per 5 min
const TIMEOUT_MS  = 6000;
const PARKED_HEARTBEAT_MS = 30 * 60 * 1000; // a parked tail adds a point at most every 30 min (keeps the cache small)
const MAX_SEEN_S  = 600;                  // ignore fixes older than 10 min (receiver "memory")

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};
const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS, ...extra },
  });

async function getJSON(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'c5-tracker/1.0' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

const listOf = j => (j && (j.ac || j.aircraft)) || [];
const hasFix = ac => ac && typeof ac.lat === 'number' && typeof ac.lon === 'number' &&
                     (ac.seen_pos == null || ac.seen_pos <= MAX_SEEN_S);

// Looks up many hexes with as few subrequests as possible (free plan allows 50 per run).
// One comma-separated request per source; hexes still missing go on to the next source.
async function lookupHexes(hexes) {
  const found = {};
  let remaining = hexes.slice();
  for (const src of SOURCES) {
    if (!remaining.length) break;
    try {
      const j = await getJSON(`${src.base}/hex/${remaining.join(',')}`);
      for (const ac of listOf(j)) {
        const hex = String(ac.hex || '').toLowerCase().replace('~', '');
        if (remaining.includes(hex) && hasFix(ac)) found[hex] = ac;
      }
      remaining = remaining.filter(h => !found[h]);
    } catch (e) { /* source down: try the next one */ }
  }
  return found;
}

async function lookupOne(kind, value) { // kind: 'hex' | 'cs' | 'reg'
  for (const src of SOURCES) {
    try {
      const path = kind === 'hex' ? `hex/${value}` : `${src[kind]}/${encodeURIComponent(value)}`;
      const j = await getJSON(`${src.base}/${path}`);
      const list = listOf(j);
      if (list.length) return { ac: list, source: src.base };
    } catch (e) {}
  }
  return null;
}

async function readCache(env) {
  try { return (await env.C5_CACHE.get(CACHE_KEY, 'json')) || {}; } catch (e) { return {}; }
}

async function refreshFleet(env) {
  const fleet = await readCache(env);
  const found = await lookupHexes(AIRCRAFT_HEXES);
  const now = Date.now();
  let updated = 0;
  for (const hex of AIRCRAFT_HEXES) {
    const ac = found[hex];
    if (!ac) continue; // no live fix: keep the previous entry untouched
    const prev = fleet[hex] || {};
    const ground = ac.alt_baro === 'ground';
    const alt = ground ? 0 : (typeof ac.alt_baro === 'number' ? ac.alt_baro : (ac.alt_geom || 0));
    const ts = now - Math.round((ac.seen_pos || 0) * 1000);
    let history = Array.isArray(prev.history) ? prev.history : [];
    const last = history[history.length - 1];
    const parkedSame = last && last.g === 1 && ground && last.lat === ac.lat && last.lon === ac.lon && ts - last.ts < PARKED_HEARTBEAT_MS;
    if ((!last || ts > last.ts) && !parkedSame) history.push({ lat: ac.lat, lon: ac.lon, alt, gs: ac.gs ?? null, g: ground ? 1 : 0, ts });
    history = history.filter(p => now - p.ts <= MAX_AGE_MS).slice(-MAX_POINTS);
    fleet[hex] = { ac, cachedAt: now, history };
    updated++;
  }
  await env.C5_CACHE.put(CACHE_KEY, JSON.stringify(fleet)); // one write per run
  return { updated, total: AIRCRAFT_HEXES.length };
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshFleet(env));
  },

  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const u = new URL(request.url);

    // Whole database in one call (best for map pages)
    if (u.searchParams.get('fleet')) {
      // Return the stored text as-is (no parse/stringify) so this stays cheap even with 50 tails.
      const raw = await env.C5_CACHE.get(CACHE_KEY, 'text');
      return new Response(raw || '{}', { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS } });
    }

    // Manual refresh for testing: ?refresh=1
    if (u.searchParams.get('refresh')) return json(await refreshFleet(env));

    const hex = (u.searchParams.get('hex') || '').toLowerCase();
    if (hex) {
      const live = await lookupOne('hex', hex);
      if (live) return json({ ...live, cached: false });
      const cache = await readCache(env);
      const e = cache[hex];
      if (e) return json({ ac: [e.ac], cached: true, cachedAt: e.cachedAt, history: e.history });
      return json({ ac: [], cached: false });
    }

    const cs = u.searchParams.get('callsign');
    if (cs) return json((await lookupOne('cs', cs)) || { ac: [] });
    const reg = u.searchParams.get('reg');
    if (reg) return json((await lookupOne('reg', reg)) || { ac: [] });

    return json({ ok: true, usage: '?fleet=1 | ?hex=ae051a | ?callsign=REACH407 | ?reg=N123', tails: AIRCRAFT_HEXES.length });
  },
};
