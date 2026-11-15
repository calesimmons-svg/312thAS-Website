// C-5 Tracker Worker  ·  v4 (50 tails + this-year tally + airframes.io satellite ADS-C over the oceans)
// Cron (every 5 min) polls public ADS-B feeds for the 16 tails and stores one
// shared "database" in KV (key: fleet-cache). Every site reads it via ?fleet=1.
//
// Cache shape (one KV key, written once per cron run):
//   { "<hex>": { ac: {...latest raw aircraft...}, cachedAt: <ms>, history: [ {lat,lon,alt,gs,g,ts}, ... ] } }
//   alt = feet (0 when on the ground), gs = knots, g = 1 when the transponder reports "ground"
//
// Year tally (second KV key: year-stats), read via ?year=1. Small, kept for the whole calendar year:
//   { y: 2026, d: { "2026-11-14": { "<hex>": { f: <times active>, p: [[lat,lon,g], ...] } } }, o: { "<hex>": <last airborne ts> } }
//   f counts takeoffs the same way the page does; p holds rounded takeoff/landing/parked spots so the page can work out countries.
//
// Oceanic positions: airframes.io (community ACARS/SATCOM decoders) logs ADS-C satellite position reports.
// Each run: scan airframes.io's newest flights for our tails, also check a few tails directly (rotating),
// then pull ADS-C positions for any active C-5 flight and merge them into the same history (marked s: 1).
// State rides inside fleet-cache under "_af" (no extra KV write); ?af=1 shows it. Data provided by Airframes.io and its community of feeders.

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
const AF_BASE     = 'https://api.airframes.io/v1';
const AF_ROTATE   = 3;                    // tails checked directly per run (all 50 about every 85 min)
const AF_KEEP_MS  = 18 * 3600e3;          // stop polling a flight 18 h after its last satellite report
const AF_MAX_FLTS = 20;                   // cap on flights polled per run (subrequest budget)
const YEAR_KEY    = 'year-stats';
const TZ          = 'America/Los_Angeles'; // day boundaries match the page
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

// ---- this-year tally ----
const dayOf = ts => new Date(ts).toLocaleDateString('en-CA', { timeZone: TZ });
const isAir = p => !p.g && (p.gs != null ? p.gs >= 50 : p.alt > 1000);
const GAP_MS = 6 * 3600e3; // out of coverage this long: the open flight is closed

// Feeds one history point into the tally. Returns true if anything changed.
function tally(ys, hex, p) {
  const k = dayOf(p.ts);
  if (!k.startsWith(String(ys.y))) return false;
  let open = ys.o[hex] || null, changed = false;
  if (open && p.ts - open > GAP_MS) open = null;
  const slot = () => { ys.d[k] = ys.d[k] || {}; return ys.d[k][hex] = ys.d[k][hex] || { f: 0, p: [] }; };
  const addP = g => {
    const lat = Math.round(p.lat * 10) / 10, lon = Math.round(p.lon * 10) / 10, s = slot();
    if (!s.p.some(q => q[0] === lat && q[1] === lon && q[2] === g)) { s.p.push([lat, lon, g]); changed = true; }
  };
  if (isAir(p)) {
    if (!open) { slot().f++; changed = true; addP(0); }
    open = p.ts;
  } else {
    if (open || p.g) addP(1);
    open = null;
  }
  if ((ys.o[hex] || null) !== open) { ys.o[hex] = open; changed = true; }
  return changed;
}

async function readYear(env, fleet) {
  const y = Number(dayOf(Date.now()).slice(0, 4));
  let ys = null;
  try { ys = await env.C5_CACHE.get(YEAR_KEY, 'json'); } catch (e) {}
  if (ys && ys.y === y) return { ys, dirty: false };
  // First run (or a new year): start fresh and replay whatever history is already cached.
  ys = { y, d: {}, o: {} };
  for (const hex of AIRCRAFT_HEXES) {
    const h = ((fleet[hex] || {}).history || []).slice().sort((a, b) => a.ts - b.ts);
    for (const p of h) tally(ys, hex, p);
  }
  return { ys, dirty: true };
}

// ---- airframes.io (satellite ADS-C) ----
function readAF(fleet) {
  const st = fleet._af;
  return st && st.flights ? st : { flights: {}, ids: {} };
}

// Returns { hex: [points...] } of new satellite positions (oldest first), and updates st in place.
async function pollAirframes(st) {
  const now = Date.now(), want = new Set(AIRCRAFT_HEXES), out = {};
  const track = (fl, hex) => {
    if (!fl || !fl.id) return;
    const ts = Date.parse(fl.updatedAt || fl.createdAt || 0) || now;
    if (now - ts > AF_KEEP_MS) return;
    const cur = st.flights[fl.id] || { hex, last: 0 };
    cur.hex = hex; cur.cs = (fl.flightIcao || fl.flight || cur.cs || '').trim(); cur.seen = Math.max(cur.seen || 0, ts);
    st.flights[fl.id] = cur;
  };
  // 1) newest flights across airframes.io (about the last 8-10 minutes)
  try {
    const list = await getJSON(`${AF_BASE}/flights?limit=500`);
    for (const fl of (Array.isArray(list) ? list : list.data || [])) {
      const hex = String((fl.airframe || {}).icao || '').toLowerCase();
      if (want.has(hex)) track(fl, hex);
    }
  } catch (e) {}
  // 2) backup: a few tails checked directly each run, in rotation
  const rot = (Math.floor(now / 300e3) * AF_ROTATE) % AIRCRAFT_HEXES.length; // rotation from the clock, so no extra write
  for (let i = 0; i < AF_ROTATE; i++) {
    const hex = AIRCRAFT_HEXES[(rot + i) % AIRCRAFT_HEXES.length];
    try {
      if (!st.ids[hex]) { const a = await getJSON(`${AF_BASE}/airframes/icao/${hex.toUpperCase()}`); if (a && a.id) st.ids[hex] = a.id; }
      if (st.ids[hex]) { const a = await getJSON(`${AF_BASE}/airframes/${st.ids[hex]}`); for (const fl of (a.flights || [])) track(fl, hex); }
    } catch (e) {}
  }
  // 3) ADS-C positions for each active flight (newest-seen first)
  const ids = Object.keys(st.flights).sort((a, b) => (st.flights[b].seen || 0) - (st.flights[a].seen || 0));
  for (const id of ids.slice(0, AF_MAX_FLTS)) {
    const f = st.flights[id];
    try {
      const j = await getJSON(`${AF_BASE}/flights/${id}/messages?limit=100`);
      const msgs = (j.data || j || []).filter(m => m && m.latitude != null && m.longitude != null && /adsc/i.test(m.sourceType || ''));
      const pts = msgs.map(m => ({ lat: +m.latitude, lon: +m.longitude, alt: m.altitude ? +m.altitude : 30000, gs: null, g: 0, ts: Date.parse(m.timestamp), s: 1, cs: f.cs }))
        .filter(p => p.ts > (f.last || 0) && p.ts <= now + 60e3 && isFinite(p.lat) && isFinite(p.lon)).sort((a, b) => a.ts - b.ts);
      if (pts.length) { f.last = pts[pts.length - 1].ts; f.seen = Math.max(f.seen || 0, f.last); (out[f.hex] = out[f.hex] || []).push(...pts); }
    } catch (e) {}
  }
  // forget flights with nothing new for a long time
  for (const id of Object.keys(st.flights)) if (now - Math.max(st.flights[id].seen || 0, st.flights[id].last || 0) > AF_KEEP_MS) delete st.flights[id];
  for (const h in out) out[h].sort((a, b) => a.ts - b.ts);
  return out;
}

async function refreshFleet(env) {
  const fleet = await readCache(env);
  const af = readAF(fleet);
  const sat = await pollAirframes(af);
  let { ys, dirty } = await readYear(env, fleet);
  const found = await lookupHexes(AIRCRAFT_HEXES);
  const now = Date.now();
  let updated = 0;
  let satPts = 0;
  for (const hex of AIRCRAFT_HEXES) {
    // satellite (ADS-C) points first: they are older than this run's ADS-B fix
    for (const sp of (sat[hex] || [])) {
      const e = fleet[hex] = fleet[hex] || { ac: null, cachedAt: 0, history: [] };
      e.history = Array.isArray(e.history) ? e.history : [];
      const last = e.history[e.history.length - 1];
      if (last && sp.ts <= last.ts) continue;
      const pt = { lat: sp.lat, lon: sp.lon, alt: sp.alt, gs: null, g: 0, ts: sp.ts, s: 1 };
      e.history.push(pt);
      if (tally(ys, hex, pt)) dirty = true;
      if (!found[hex] && (!e.cachedAt || sp.ts >= e.cachedAt)) {
        e.ac = { hex, flight: sp.cs || '', lat: sp.lat, lon: sp.lon, alt_baro: sp.alt, src: 'airframes-adsc' };
        e.cachedAt = sp.ts;
      }
      e.history = e.history.filter(p => now - p.ts <= MAX_AGE_MS).slice(-MAX_POINTS);
      satPts++;
    }
    const ac = found[hex];
    if (!ac) continue; // no live fix: keep the previous entry untouched
    const prev = fleet[hex] || {};
    const ground = ac.alt_baro === 'ground';
    const alt = ground ? 0 : (typeof ac.alt_baro === 'number' ? ac.alt_baro : (ac.alt_geom || 0));
    const ts = now - Math.round((ac.seen_pos || 0) * 1000);
    let history = Array.isArray(prev.history) ? prev.history : [];
    const last = history[history.length - 1];
    const parkedSame = last && last.g === 1 && ground && last.lat === ac.lat && last.lon === ac.lon && ts - last.ts < PARKED_HEARTBEAT_MS;
    if ((!last || ts > last.ts) && !parkedSame) {
      const pt = { lat: ac.lat, lon: ac.lon, alt, gs: ac.gs ?? null, g: ground ? 1 : 0, ts };
      history.push(pt);
      if (tally(ys, hex, pt)) dirty = true;
    }
    history = history.filter(p => now - p.ts <= MAX_AGE_MS).slice(-MAX_POINTS);
    fleet[hex] = { ac, cachedAt: now, history };
    updated++;
  }
  fleet._af = af; // airframes.io state rides along in the same write
  await env.C5_CACHE.put(CACHE_KEY, JSON.stringify(fleet)); // one write per run
  if (dirty) await env.C5_CACHE.put(YEAR_KEY, JSON.stringify(ys)); // only when the tally changed
  return { updated, total: AIRCRAFT_HEXES.length, year: ys.y, days: Object.keys(ys.d).length, satPoints: satPts, satFlights: Object.keys(af.flights).length };
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

    // This-year tally (times active + spots for countries)
    if (u.searchParams.get('year')) {
      const raw = await env.C5_CACHE.get(YEAR_KEY, 'text');
      return new Response(raw || '{}', { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS } });
    }

    // airframes.io tracking state (debug)
    if (u.searchParams.get('af')) return json(readAF(await readCache(env)));

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

    return json({ ok: true, usage: '?fleet=1 | ?year=1 | ?af=1 | ?hex=ae051a | ?callsign=REACH407 | ?reg=N123', tails: AIRCRAFT_HEXES.length });
  },
};
