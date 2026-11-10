/**
 * Fred layovers — Cloudflare Worker API (D1 database; airfield map images are stored in D1 too)
 *
 * Bindings / settings the Worker needs:
 *   DB              D1 database binding (fred-layovers)
 *   POST_CODE       secret: shared squadron code required for any change
 *   ALLOWED_ORIGIN  variable: your GitHub Pages origin, e.g. https://you.github.io  ("*" = any)
 *
 * Routes:
 *   GET  /data                      everything the site needs
 *   GET  /wx?ids=KSUU,KCEF          current METARs from aviationweather.gov (cached 5 min)
 *   GET  /forecast?site=KCEF        next 30 hours, hour by hour, from Open-Meteo (cached 30 min)
 *   POST /entries                   add a spot            {loc, cat, name, area, note, lat, lng, link}
 *   PUT  /entries/:id               edit a spot           {loc, cat, name, area, note, lat, lng, link}
 *   PUT  /entries/:id/details       hotel info (shuttle, gym, laundry, ...) {details: {field: text}}
 *   POST /resolve                   read coordinates from a Google/Apple Maps link {url}
 *   POST /events                    add a Westover Mob calendar event
 *   PUT  /events/:id                edit an event (whole series if it repeats)
 *   DELETE /events/:id              delete an event (whole series)
 *   POST /events/:id/skip           remove one day from a repeating event {date}
 *   POST /entries/:id/vote          vote                  {dir, prev}  (each -1, 0, or 1)
 *   POST /stations                  add a location        {icao, city, region, cpName, cpFreq}
 *   PUT  /stations/:icao            update any of          {city, region, cpName, cpFreq, notes}
 *   DELETE /entries/:id             delete a spot
 *   DELETE /stations/:icao          delete a location and all of its spots and maps
 *   GET  /photos/:id                airfield map image (?t=1 for the thumbnail)
 *   POST /stations/:icao/photos     upload a map (multipart: full, thumb, caption, w, h)
 *   DELETE /photos/:id              delete a map
 */

const CATS = ['eat', 'drink', 'hotel', 'act'];

// Hard caps so storage can never grow past the free tier
const MAX_PHOTOS = 50;             // total maps across all stations
const MAX_PHOTOS_PER_DAY = 40;     // uploads per UTC day, squadron-wide
const MAX_FULL_BYTES = 1400000;    // 1.4 MB per full image; stored as text it stays under D1's 2 MB row limit
const MAX_THUMB_BYTES = 150000;    // 150 KB per thumbnail

export default {
  async fetch(req, env, ctx) {
    const cors = corsHeaders(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    let res;
    try {
      res = await route(req, env, ctx);
    } catch (e) {
      res = json({ error: e.expose ? e.message : 'Server error' }, e.status || 500);
      if (!e.expose) console.error(e);
    }
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  }
};

async function route(req, env, ctx) {
  const parts = new URL(req.url).pathname.split('/').filter(Boolean);
  const m = req.method;

  if (m === 'GET' && parts[0] === 'data' && parts.length === 1) return getData(env);
  if (m === 'GET' && parts[0] === 'wx' && parts.length === 1) return getWx(req, ctx);
  if (m === 'GET' && parts[0] === 'forecast' && parts.length === 1) return getForecast(req, ctx);
  if (m === 'GET' && parts[0] === 'photos' && parts.length === 2) return getPhoto(req, env, ctx, parts[1]);

  // Everything below changes data and needs the squadron code
  if (!env.POST_CODE || req.headers.get('X-Post-Code') !== env.POST_CODE) fail(401, 'Wrong or missing squadron code');

  // Map uploads are multipart, not JSON
  if (m === 'POST' && parts[0] === 'stations' && parts.length === 3 && parts[2] === 'photos') return addPhoto(req, env, parts[1]);
  if (m === 'DELETE' && parts[0] === 'photos' && parts.length === 2) return deletePhoto(env, parts[1]);
  const body = m === 'DELETE' ? {} : await req.json().catch(() => fail(400, 'Body must be JSON'));

  if (m === 'POST' && parts[0] === 'resolve' && parts.length === 1) return resolveLink(body);

  if (parts[0] === 'entries') {
    if (m === 'POST' && parts.length === 1) return addEntry(env, body);
    if (m === 'PUT' && parts.length === 2) return editEntry(env, parts[1], body);
    if (m === 'DELETE' && parts.length === 2) return deleteEntry(env, parts[1]);
    if (m === 'POST' && parts.length === 3 && parts[2] === 'vote') return vote(env, parts[1], body);
    if (m === 'PUT' && parts.length === 3 && parts[2] === 'details') return saveDetails(env, parts[1], body);
  }
  if (parts[0] === 'events') {
    if (m === 'POST' && parts.length === 1) return addEvent(env, body);
    if (m === 'PUT' && parts.length === 2) return editEvent(env, parts[1], body);
    if (m === 'DELETE' && parts.length === 2) return deleteEvent(env, parts[1]);
    if (m === 'POST' && parts.length === 3 && parts[2] === 'skip') return skipEvent(env, parts[1], body);
  }
  if (parts[0] === 'stations') {
    if (m === 'POST' && parts.length === 1) return addStation(env, body);
    if (m === 'PUT' && parts.length === 2) return updateStation(env, parts[1], body);
    if (m === 'DELETE' && parts.length === 2) return deleteStation(env, parts[1]);
  }
  fail(404, 'Not found');
}

/* ---------- Read ---------- */
async function getData(env) {
  await ensureGeo(env);
  await ensurePhotos(env);
  const [st, en] = await env.DB.batch([
    env.DB.prepare('SELECT icao, city, region, cp_name, cp_freq, notes, alt FROM stations ORDER BY rowid'),
    env.DB.prepare('SELECT id, loc, cat, name, area, note, created, up, down, lat, lng, details, link FROM entries')
  ]);
  // Maps are read separately so the site still loads if the photos table hasn't been created yet
  let photos = [];
  try {
    photos = (await env.DB.prepare('SELECT id, loc, caption, created, w, h FROM photos ORDER BY created').all()).results;
  } catch (e) { /* no photos table yet */ }
  await ensureEvents(env);
  const events = (await env.DB.prepare('SELECT * FROM events ORDER BY date, start_time').all()).results.map(eventOut);
  return json({
    photoLimit: MAX_PHOTOS,
    photos,
    events,
    stations: st.results.map(s => ({
      code: s.icao, alt: s.alt || '', city: s.city, region: s.region,
      cp: { name: s.cp_name, freq: s.cp_freq, notes: s.notes }
    })),
    entries: en.results.map(e => ({
      id: e.id, loc: e.loc, cat: e.cat, name: e.name, area: e.area, note: e.note,
      date: e.created, up: e.up, down: e.down, lat: e.lat, lng: e.lng, details: parseDetails(e.details), link: e.link || null
    }))
  });
}

/* ---------- Spots ---------- */
async function spotFields(env, b) {
  const f = {
    loc: clean(b.loc, 4).toUpperCase(), cat: clean(b.cat, 10),
    name: clean(b.name, 60), area: clean(b.area, 40), note: clean(b.note, 1500)
  };
  if (!f.name) fail(400, 'Name is required');
  if (!CATS.includes(f.cat)) fail(400, 'Unknown category');
  const st = await env.DB.prepare('SELECT 1 FROM stations WHERE icao = ?').bind(f.loc).first();
  if (!st) fail(400, 'Unknown station');
  [f.lat, f.lng] = coords(b);
  f.hasCoords = 'lat' in b || 'lng' in b;   // older pages don't send coordinates; leave them alone
  f.hasLink = 'link' in b;
  f.link = cleanLink(b.link);
  return f;
}

// Google Maps / Apple Maps link for a spot (https only, map sites only)
function cleanLink(v) {
  const t = String(v ?? '').trim();
  if (!t) return null;
  let u;
  try { u = new URL(t); } catch (e) { fail(400, 'Map link must be a full https link'); }
  if (u.protocol !== 'https:') fail(400, 'Map link must start with https://');
  if (!/(^|\.)(google\.com|goo\.gl|apple\.com)$/i.test(u.hostname)) fail(400, 'Only Google Maps or Apple Maps links');
  if (t.length > 600) fail(400, 'Map link is too long');
  return t;
}

function coords(b) {
  const has = v => v !== null && v !== undefined && v !== '';
  if (!has(b.lat) && !has(b.lng)) return [null, null];
  const lat = Number(b.lat), lng = Number(b.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) fail(400, 'Bad map location');
  return [Math.round(lat * 1e6) / 1e6, Math.round(lng * 1e6) / 1e6];
}

// Adds the lat/lng columns the first time they're needed, so no manual database step is required
let geoReady = false;
async function ensureGeo(env) {
  if (geoReady) return;
  const cols = (await env.DB.prepare('PRAGMA table_info(entries)').all()).results.map(c => c.name);
  for (const [c, type] of [['lat', 'REAL'], ['lng', 'REAL'], ['details', 'TEXT'], ['link', 'TEXT']]) {
    if (!cols.includes(c)) {
      try { await env.DB.prepare(`ALTER TABLE entries ADD COLUMN ${c} ${type}`).run(); }
      catch (e) { if (!/duplicate column/i.test(String(e.message))) throw e; }
    }
  }
  // stations.alt: an old or second code shown small next to the main one, e.g. PHNL (PHIK)
  const scols = (await env.DB.prepare('PRAGMA table_info(stations)').all()).results.map(c => c.name);
  if (!scols.includes('alt')) {
    try { await env.DB.prepare('ALTER TABLE stations ADD COLUMN alt TEXT').run(); }
    catch (e) { if (!/duplicate column/i.test(String(e.message))) throw e; }
  }
  geoReady = true;
}

async function addEntry(env, b) {
  await ensureGeo(env);
  const f = await spotFields(env, b);
  const id = crypto.randomUUID(), created = new Date().toISOString();
  await env.DB.prepare(
    'INSERT INTO entries (id, loc, cat, name, area, note, created, lat, lng, link) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, f.loc, f.cat, f.name, f.area, f.note, created, f.lat, f.lng, f.link).run();
  return json({ ok: true, id, created }, 201);
}

async function editEntry(env, id, b) {
  await ensureGeo(env);
  const f = await spotFields(env, b);
  const sets = ['loc = ?', 'cat = ?', 'name = ?', 'area = ?', 'note = ?'];
  const vals = [f.loc, f.cat, f.name, f.area, f.note];
  if (f.hasCoords) { sets.push('lat = ?', 'lng = ?'); vals.push(f.lat, f.lng); }   // older pages don't send these; leave them alone
  if (f.hasLink) { sets.push('link = ?'); vals.push(f.link); }
  const r = await env.DB.prepare(`UPDATE entries SET ${sets.join(', ')} WHERE id = ?`).bind(...vals, id).run();
  if (!r.meta.changes) fail(404, 'Spot not found');
  return json({ ok: true });
}

/* ---------- Hotel info ---------- */
const DETAIL_KEYS = ['shuttle', 'breakfast', 'coffee', 'room', 'laundry', 'points', 'wifi', 'discounts',
                     'fridge', 'microwave', 'gym', 'pool', 'food', 'todo', 'other'];
function parseDetails(txt) {
  if (!txt) return null;
  try { const o = JSON.parse(txt); return o && typeof o === 'object' ? o : null; } catch (e) { return null; }
}
async function saveDetails(env, id, b) {
  await ensureGeo(env);
  const src = b && typeof b.details === 'object' && b.details ? b.details : fail(400, 'Missing hotel info');
  const out = {};
  for (const k of DETAIL_KEYS) {
    const v = clean(src[k], 2000);
    if (v) out[k] = v;
  }
  const row = await env.DB.prepare('SELECT cat FROM entries WHERE id = ?').bind(id).first();
  if (!row) fail(404, 'Spot not found');
  if (row.cat !== 'hotel') fail(400, 'Hotel info is only for hotels');
  const txt = Object.keys(out).length ? JSON.stringify(out) : null;
  await env.DB.prepare('UPDATE entries SET details = ? WHERE id = ?').bind(txt, id).run();
  return json({ ok: true, details: out });
}

async function deleteEntry(env, id) {
  const r = await env.DB.prepare('DELETE FROM entries WHERE id = ?').bind(id).run();
  if (!r.meta.changes) fail(404, 'Spot not found');
  return json({ ok: true });
}

async function vote(env, id, b) {
  const ok = v => v === -1 || v === 0 || v === 1;
  if (!ok(b.dir) || !ok(b.prev)) fail(400, 'dir and prev must be -1, 0, or 1');
  const upD = (b.dir === 1) - (b.prev === 1);
  const downD = (b.dir === -1) - (b.prev === -1);
  // Single atomic update, so simultaneous votes never overwrite each other
  const r = await env.DB.prepare(
    'UPDATE entries SET up = MAX(0, up + ?), down = MAX(0, down + ?) WHERE id = ? RETURNING up, down'
  ).bind(upD, downD, id).first();
  if (!r) fail(404, 'Spot not found');
  return json({ ok: true, up: r.up, down: r.down });
}

/* ---------- Stations ---------- */
const validFreq = f => !f || f.split(/[\/,]/).every(x => {
  x = x.trim(); const n = +x;
  return /^\d{1,3}(\.\d{1,3})?$/.test(x) && n >= 2 && n <= 400;
});

async function addStation(env, b) {
  const icao = clean(b.icao, 4).toUpperCase();
  const city = clean(b.city, 24), region = clean(b.region, 40);
  const cpName = clean(b.cpName, 40), cpFreq = clean(b.cpFreq, 40);
  if (!/^[A-Z][A-Z0-9]{3}$/.test(icao)) fail(400, 'ICAO must be four characters starting with a letter');
  if (!city) fail(400, 'Base or city is required');
  if (!validFreq(cpFreq)) fail(400, 'Bad frequency');
  const r = await env.DB.prepare(
    'INSERT OR IGNORE INTO stations (icao, city, region, cp_name, cp_freq) VALUES (?, ?, ?, ?, ?)'
  ).bind(icao, city, region, cpName, cpFreq).run();
  if (!r.meta.changes) fail(409, `${icao} already exists`);
  return json({ ok: true }, 201);
}

async function updateStation(env, icao, b) {
  const sets = [], vals = [];
  if ('city' in b) {
    const c = clean(b.city, 24);
    if (!c) fail(400, 'Base or city is required');
    sets.push('city = ?'); vals.push(c);
  }
  if ('region' in b) { sets.push('region = ?'); vals.push(clean(b.region, 40)); }
  if ('cpName' in b) { sets.push('cp_name = ?'); vals.push(clean(b.cpName, 40)); }
  if ('cpFreq' in b) {
    const f = clean(b.cpFreq, 40);
    if (!validFreq(f)) fail(400, 'Bad frequency');
    sets.push('cp_freq = ?'); vals.push(f);
  }
  if ('notes' in b) { sets.push('notes = ?'); vals.push(clean(b.notes, 2000)); }
  if (!sets.length) fail(400, 'Nothing to update');
  const r = await env.DB.prepare(`UPDATE stations SET ${sets.join(', ')} WHERE icao = ?`)
    .bind(...vals, icao.toUpperCase()).run();
  if (!r.meta.changes) fail(404, 'Station not found');
  return json({ ok: true });
}

async function deleteStation(env, icao) {
  icao = icao.toUpperCase();
  await ensurePhotos(env);
  const res = await env.DB.batch([
    env.DB.prepare('DELETE FROM entries WHERE loc = ?').bind(icao),
    env.DB.prepare('DELETE FROM photo_data WHERE id IN (SELECT id FROM photos WHERE loc = ?)').bind(icao),
    env.DB.prepare('DELETE FROM photos WHERE loc = ?').bind(icao),
    env.DB.prepare('DELETE FROM stations WHERE icao = ?').bind(icao)
  ]);
  if (!res[res.length - 1].meta.changes) fail(404, 'Station not found');
  return json({ ok: true });
}

/* ---------- Airfield maps (stored in D1, no R2 or card needed) ---------- */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Creates the two map tables the first time they're needed
let photosReady = false;
async function ensurePhotos(env) {
  if (photosReady) return;
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS photos (id TEXT PRIMARY KEY, loc TEXT NOT NULL, caption TEXT NOT NULL DEFAULT '', created TEXT NOT NULL, bytes INTEGER NOT NULL DEFAULT 0, w INTEGER NOT NULL DEFAULT 0, h INTEGER NOT NULL DEFAULT 0)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS photo_data (id TEXT NOT NULL, kind TEXT NOT NULL, mime TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (id, kind))")
  ]);
  photosReady = true;
}

// Images are kept as base64 text: simple, and every D1 driver returns text the same way
function toB64(buf) {
  const b = new Uint8Array(buf); let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(str) {
  const bin = atob(str), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function getPhoto(req, env, ctx, id) {
  if (!UUID.test(id)) fail(404, 'Not found');
  const cache = globalThis.caches ? caches.default : null;
  if (cache) {
    const hit = await cache.match(req);
    if (hit) return new Response(hit.body, hit);
  }
  await ensurePhotos(env);
  const kind = new URL(req.url).searchParams.get('t') === '1' ? 'thumb' : 'full';
  const row = await env.DB.prepare('SELECT mime, data FROM photo_data WHERE id = ? AND kind = ?').bind(id, kind).first();
  if (!row) fail(404, 'Not found');
  const res = new Response(fromB64(row.data), { headers: {
    'Content-Type': row.mime || 'image/jpeg',
    'Cache-Control': 'public, max-age=31536000, immutable',   // browsers keep it, so repeat views cost nothing
    'ETag': `"${id}-${kind}"`
  }});
  if (cache && ctx) ctx.waitUntil(cache.put(req, res.clone()));
  return res;
}

function isImage(buf) {
  const b = new Uint8Array(buf.slice(0, 12));
  const jpeg = b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF;
  const webp = String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP';
  return jpeg || webp;
}

async function addPhoto(req, env, icao) {
  icao = icao.toUpperCase();
  await ensurePhotos(env);
  const st = await env.DB.prepare('SELECT 1 FROM stations WHERE icao = ?').bind(icao).first();
  if (!st) fail(400, 'Unknown station');

  const total = (await env.DB.prepare('SELECT COUNT(*) AS n FROM photos').first()).n;
  if (total >= MAX_PHOTOS) fail(409, `All ${MAX_PHOTOS} map slots are used. Delete an old map to add a new one.`);
  const today = new Date().toISOString().slice(0, 10);
  const todayCount = (await env.DB.prepare('SELECT COUNT(*) AS n FROM photos WHERE created >= ?').bind(today).first()).n;
  if (todayCount >= MAX_PHOTOS_PER_DAY) fail(429, 'Daily upload limit reached. Try again tomorrow.');

  const form = await req.formData().catch(() => fail(400, 'Expected an image upload'));
  const full = form.get('full'), thumb = form.get('thumb');
  if (!full || !thumb || typeof full.arrayBuffer !== 'function' || typeof thumb.arrayBuffer !== 'function') fail(400, 'Missing image');
  if (full.size > MAX_FULL_BYTES) fail(413, 'Image is too large even after resizing');
  if (thumb.size > MAX_THUMB_BYTES) fail(413, 'Thumbnail is too large');
  const fb = await full.arrayBuffer(), tb = await thumb.arrayBuffer();
  if (!isImage(fb) || !isImage(tb)) fail(415, 'Only JPEG or WebP images are allowed');

  const id = crypto.randomUUID(), created = new Date().toISOString();
  const caption = clean(form.get('caption'), 60);
  const w = Math.max(0, Math.min(10000, parseInt(form.get('w')) || 0));
  const h = Math.max(0, Math.min(10000, parseInt(form.get('h')) || 0));
  const mime = t => (t === 'image/webp' ? 'image/webp' : 'image/jpeg');
  await env.DB.batch([    // all three rows are written together, or none are
    env.DB.prepare('INSERT INTO photo_data (id, kind, mime, data) VALUES (?, ?, ?, ?)').bind(id, 'full', mime(full.type), toB64(fb)),
    env.DB.prepare('INSERT INTO photo_data (id, kind, mime, data) VALUES (?, ?, ?, ?)').bind(id, 'thumb', mime(thumb.type), toB64(tb)),
    env.DB.prepare('INSERT INTO photos (id, loc, caption, created, bytes, w, h) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(id, icao, caption, created, fb.byteLength + tb.byteLength, w, h)
  ]);
  return json({ ok: true, photo: { id, loc: icao, caption, created, w, h } }, 201);
}

async function deletePhoto(env, id) {
  if (!UUID.test(id)) fail(404, 'Map not found');
  await ensurePhotos(env);
  const [, r] = await env.DB.batch([
    env.DB.prepare('DELETE FROM photo_data WHERE id = ?').bind(id),
    env.DB.prepare('DELETE FROM photos WHERE id = ?').bind(id)
  ]);
  if (!r.meta.changes) fail(404, 'Map not found');
  return json({ ok: true });
}

/* ---------- Weather (METAR) ---------- */
async function getWx(req, ctx) {
  const ids = (new URL(req.url).searchParams.get('ids') || '').toUpperCase().split(',')
    .map(s => s.trim()).filter(s => /^[A-Z][A-Z0-9]{3}$/.test(s)).slice(0, 6);
  if (!ids.length) fail(400, 'Add station ids, like ?ids=KSUU,KCEF');
  const key = new Request('https://wx.cache/metar?ids=' + ids.sort().join(','));
  const cache = globalThis.caches ? caches.default : null;
  if (cache) { const hit = await cache.match(key); if (hit) return new Response(hit.body, hit); }
  const r = await fetch(`https://aviationweather.gov/api/data/metar?ids=${ids.join(',')}&format=json`,
    { headers: { 'User-Agent': 'fred-layovers (312th AS crew site)' } });
  if (!r.ok) fail(502, 'Weather service is not answering right now');
  const raw = await r.json().catch(() => []);
  const out = (Array.isArray(raw) ? raw : []).map(m => ({
    id: m.icaoId, name: m.name, obsTime: m.obsTime, temp: m.temp, dewp: m.dewp,
    wdir: m.wdir, wspd: m.wspd, wgst: m.wgst, visib: m.visib, altim: m.altim,
    fltCat: m.fltCat, clouds: m.clouds || [], wx: m.wxString || '', raw: m.rawOb
  }));
  const res = new Response(JSON.stringify(out), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' } });
  if (cache && ctx) ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

/* ---------- Hourly forecast (Open-Meteo, free, no key) ---------- */
const FORECAST_SITES = {
  KCEF: [42.1940, -72.5348, 'America/New_York'],      // Westover ARB
  KSUU: [38.2627, -121.9275, 'America/Los_Angeles']   // Travis AFB
};
async function getForecast(req, ctx) {
  const site = (new URL(req.url).searchParams.get('site') || 'KCEF').toUpperCase();
  const f = FORECAST_SITES[site];
  if (!f) fail(400, 'Unknown site');
  const key = new Request('https://wx.cache/forecast?site=' + site);
  const cache = globalThis.caches ? caches.default : null;
  if (cache) { const hit = await cache.match(key); if (hit) return new Response(hit.body, hit); }
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${f[0]}&longitude=${f[1]}` +
    '&hourly=temperature_2m,apparent_temperature,precipitation_probability,weather_code,wind_speed_10m,wind_gusts_10m,is_day' +
    `&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=${encodeURIComponent(f[2])}&forecast_hours=30`;
  const r = await fetch(url, { headers: { 'User-Agent': 'fred-layovers (312th AS crew site)' } });
  if (!r.ok) fail(502, 'Forecast service is not answering right now');
  const j = await r.json().catch(() => null);
  const h = j && j.hourly;
  if (!h || !Array.isArray(h.time)) fail(502, 'Forecast came back empty');
  const hours = h.time.map((t, i) => ({
    t, temp: h.temperature_2m[i], feels: h.apparent_temperature[i], pop: h.precipitation_probability[i],
    code: h.weather_code[i], wind: h.wind_speed_10m[i], gust: h.wind_gusts_10m[i], day: h.is_day[i]
  }));
  const res = new Response(JSON.stringify({ site, tz: f[2], hours }),
    { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=1800' } });
  if (cache && ctx) ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

/* ---------- Westover Mob calendar ---------- */
const EV_KINDS = ['duty', 'training', 'social', 'other'];
const EV_FREQS = ['none', 'daily', 'weekdays', 'weekly', 'monthly', 'yearly'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/, TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
let eventsReady = false;
async function ensureEvents(env) {
  if (eventsReady) return;
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, title TEXT NOT NULL, date TEXT NOT NULL, all_day INTEGER NOT NULL DEFAULT 0, start_time TEXT NOT NULL DEFAULT '', end_time TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT '', details TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'other', freq TEXT NOT NULL DEFAULT 'none', every INTEGER NOT NULL DEFAULT 1, until TEXT NOT NULL DEFAULT '', exdates TEXT NOT NULL DEFAULT '[]', created TEXT NOT NULL)").run();
  eventsReady = true;
}
function validDate(s) {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}
function eventOut(e) {
  let ex = [];
  try { ex = JSON.parse(e.exdates || '[]'); } catch (err) {}
  return { id: e.id, title: e.title, date: e.date, allDay: !!e.all_day, start: e.start_time, end: e.end_time,
           location: e.location, details: e.details, kind: e.kind, freq: e.freq, every: e.every, until: e.until, exdates: ex };
}
function eventFields(b) {
  const f = {
    title: clean(b.title, 80), date: clean(b.date, 10), all_day: b.allDay ? 1 : 0,
    start_time: clean(b.start, 5), end_time: clean(b.end, 5),
    location: clean(b.location, 80), details: clean(b.details, 2000),
    kind: EV_KINDS.includes(b.kind) ? b.kind : 'other',
    freq: EV_FREQS.includes(b.freq) ? b.freq : 'none',
    every: Math.max(1, Math.min(30, parseInt(b.every) || 1)),
    until: clean(b.until, 10)
  };
  if (!f.title) fail(400, 'Add a title');
  if (!validDate(f.date)) fail(400, 'Pick a date');
  if (f.all_day) { f.start_time = ''; f.end_time = ''; }
  else {
    if (!TIME_RE.test(f.start_time)) fail(400, 'Pick a start time');
    if (f.end_time && !TIME_RE.test(f.end_time)) fail(400, 'End time is not valid');
  }
  if (f.freq === 'none') { f.until = ''; f.every = 1; }
  if (f.until && (!validDate(f.until) || f.until < f.date)) fail(400, 'The repeat end date must be on or after the first date');
  return f;
}
async function addEvent(env, b) {
  await ensureEvents(env);
  const f = eventFields(b), id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO events (id, title, date, all_day, start_time, end_time, location, details, kind, freq, every, until, exdates, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, f.title, f.date, f.all_day, f.start_time, f.end_time, f.location, f.details, f.kind, f.freq, f.every, f.until, '[]', new Date().toISOString()).run();
  return json({ ok: true, id }, 201);
}
async function editEvent(env, id, b) {
  await ensureEvents(env);
  const f = eventFields(b);
  const r = await env.DB.prepare('UPDATE events SET title = ?, date = ?, all_day = ?, start_time = ?, end_time = ?, location = ?, details = ?, kind = ?, freq = ?, every = ?, until = ? WHERE id = ?')
    .bind(f.title, f.date, f.all_day, f.start_time, f.end_time, f.location, f.details, f.kind, f.freq, f.every, f.until, id).run();
  if (!r.meta.changes) fail(404, 'Event not found');
  return json({ ok: true });
}
async function deleteEvent(env, id) {
  await ensureEvents(env);
  const r = await env.DB.prepare('DELETE FROM events WHERE id = ?').bind(id).run();
  if (!r.meta.changes) fail(404, 'Event not found');
  return json({ ok: true });
}
async function skipEvent(env, id, b) {
  await ensureEvents(env);
  const day = clean(b.date, 10);
  if (!validDate(day)) fail(400, 'Bad date');
  const row = await env.DB.prepare('SELECT exdates FROM events WHERE id = ?').bind(id).first();
  if (!row) fail(404, 'Event not found');
  let ex = []; try { ex = JSON.parse(row.exdates || '[]'); } catch (e) {}
  if (!ex.includes(day)) ex.push(day);
  ex = ex.sort().slice(-500);
  await env.DB.prepare('UPDATE events SET exdates = ? WHERE id = ?').bind(JSON.stringify(ex), id).run();
  return json({ ok: true, exdates: ex });
}

/* ---------- Map links -> coordinates ---------- */
function parseCoords(text) {
  const t = String(text || '');
  const tries = [
    /!3d(-?\d{1,2}\.\d+)!4d(-?\d{1,3}\.\d+)/,                                   // Google place pin
    /[?&](?:q|ll|sll|daddr|coordinate|center|query|destination)=(-?\d{1,2}\.\d+)(?:,|%2C)\s*(?:\+)?(-?\d{1,3}\.\d+)/i,
    /\/search\/(-?\d{1,2}\.\d+),\+?(-?\d{1,3}\.\d+)/,
    /@(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/                                          // Google map view
  ];
  for (const re of tries) {
    const m = t.match(re);
    if (m) {
      const lat = +m[1], lng = +m[2];
      if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0)) return [lat, lng];
    }
  }
  return null;
}

async function resolveLink(b) {
  let u;
  try { u = new URL(String(b.url || '').trim()); } catch (e) { fail(400, 'That is not a link'); }
  if (!/(^|\.)(goo\.gl|google\.com|apple\.com)$/i.test(u.hostname)) fail(400, 'Only Google Maps or Apple Maps links work here');
  let c = parseCoords(u.toString());
  if (!c) {
    const r = await fetch(u.toString(), { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en' } });
    c = parseCoords(r.url) || parseCoords((await r.text()).slice(0, 400000));
  }
  if (!c) fail(422, "Couldn't find a location in that link. Try Use my location or Pick on map.");
  return json({ ok: true, lat: c[0], lng: c[1] });
}

/* ---------- Helpers ---------- */
function clean(v, max) { return String(v ?? '').trim().slice(0, max); }

function fail(status, message) {
  const e = new Error(message); e.status = status; e.expose = true; throw e;
}

function json(o, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
}

function corsHeaders(req, env) {
  const allowed = (env.ALLOWED_ORIGIN || '*').split(',').map(s => s.trim());
  const origin = req.headers.get('Origin') || '';
  const allow = allowed.includes('*') ? '*' : (allowed.includes(origin) ? origin : allowed[0]);
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Post-Code',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}
