// 312th Airlift ACARS archive (Worker v5): copies prints from the Pi into D1, serves them to the archive page,
// and (new in v4) sends a Web Push to subscribed phones whenever a new print lands.
// It only READS from the Pi (/api/log and /api/photo/<id>). It never writes to the Pi.
//
// Push setup: add ONE secret to this Worker named VAPID_PRIVATE_JWK (see SETUP.txt). Nothing else is needed.
// Without that secret the Worker behaves exactly like v3 and push is simply off.

const PAGE = 100;          // prints fetched from the Pi per request
const IMAGES_PER_RUN = 15; // pictures copied per run (keeps us under the free plan's per-run limits)
const BACKFILL_PAGES = 2;  // older pages walked per run until the whole history is copied

// ---- push settings ----
const VAPID_PUBLIC = "BFCBEE_fYFkq3qo81S1L7cu-Vd1pnvfM5I4E0jQcxuQfMAXWn4wF2W2H181Qlc1PEF7fgV59NSjK80V3T7V_Uow"; // goes in the page too
const VAPID_SUBJECT = "https://312as.com";
const MAX_SUBS = 20;       // phones allowed to subscribe (also caps pushes per run on the free plan)
const PUSH_HOSTS = [/(^|\.)push\.apple\.com$/, /(^|\.)googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/];

const json = (o, status = 200, extra = {}) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", ...extra } });

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const ok = (env.ALLOW_ORIGIN || "").split(",").map(s => s.trim().replace(/\/$/, "")).filter(Boolean);
  return ok.includes(origin) ? { "access-control-allow-origin": origin, "vary": "Origin" } : { "vary": "Origin" };
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(buf) {
  const b = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s);
}
const b64u = buf => bytesToB64(buf).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const utf8 = s => new TextEncoder().encode(s);

async function piGet(env, path) {
  const r = await fetch(env.PI_URL.replace(/\/$/, "") + path, { headers: { "X-Pin": env.PI_PIN || "" } });
  return r;
}

function photoIdOf(lines) {
  for (const l of lines || []) {
    const t = Array.isArray(l) ? String(l[0]) : String(l);
    if (t.startsWith("photo:")) return t.slice(6);
  }
  return null;
}

async function setMeta(env, k, v) {
  await env.DB.prepare("INSERT INTO meta (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(k, String(v)).run();
}
async function getMeta(env, k) {
  const r = await env.DB.prepare("SELECT v FROM meta WHERE k=?").bind(k).first();
  return r ? r.v : null;
}

async function upsertPage(env, entries) {
  const now = new Date().toISOString();
  const stmt = env.DB.prepare("INSERT INTO prints (id,at,to_name,from_name,msg,theme,source,error,up,lines,synced_at,photo_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET up=excluded.up, error=excluded.error, synced_at=excluded.synced_at");
  const batch = entries.filter(e => e && e.id).map(e => stmt.bind(
    e.id, e.at || "", e.to || "", e.from || "", e.msg || "", e.theme || "", e.source || "",
    e.error || null, Number(e.up) || 0, JSON.stringify(e.lines || []), now, photoIdOf(e.lines)));
  if (batch.length) await env.DB.batch(batch);
  return batch.length;
}

async function fetchLog(env, offset) {
  const r = await piGet(env, `/api/log?offset=${offset}&limit=${PAGE}`);
  if (r.status === 401 || r.status === 429) throw new Error("Pi said " + r.status + " (PIN wrong or locked)");
  if (!r.ok) throw new Error("Pi log returned " + r.status);
  return r.json();
}

// ---------------------------------------------------------------------------------------------
// Web Push (no payload: the phone's service worker asks the archive how many prints are new)
// ---------------------------------------------------------------------------------------------
let pushTableReady = false;
async function ensurePushTable(env) {
  if (pushTableReady) return;
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, created_at TEXT NOT NULL, last_ok TEXT, fails INTEGER NOT NULL DEFAULT 0)").run();
  pushTableReady = true;
}

let signKey = null;
const jwtCache = new Map();
async function vapidAuth(env, endpoint) {
  const aud = new URL(endpoint).origin;
  const now = Math.floor(Date.now() / 1000);
  let c = jwtCache.get(aud);
  if (!c || c.exp - now < 3600) {
    if (!signKey) signKey = await crypto.subtle.importKey("jwk", JSON.parse(env.VAPID_PRIVATE_JWK), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    const exp = now + 12 * 3600;
    const head = b64u(utf8(JSON.stringify({ typ: "JWT", alg: "ES256" })));
    const claims = b64u(utf8(JSON.stringify({ aud, exp, sub: VAPID_SUBJECT })));
    const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signKey, utf8(head + "." + claims));
    c = { jwt: head + "." + claims + "." + b64u(sig), exp };
    jwtCache.set(aud, c);
  }
  return "vapid t=" + c.jwt + ", k=" + VAPID_PUBLIC;
}

async function sendPush(env, endpoint) {
  return fetch(endpoint, { method: "POST", headers: { "Authorization": await vapidAuth(env, endpoint), "TTL": "3600", "Urgency": "high" } });
}

async function pushAll(env) {
  await ensurePushTable(env);
  const subs = (await env.DB.prepare("SELECT endpoint FROM push_subs ORDER BY created_at LIMIT ?").bind(MAX_SUBS).all()).results || [];
  let sent = 0;
  for (const s of subs) {
    try {
      const r = await sendPush(env, s.endpoint);
      if (r.status === 404 || r.status === 410) {                       // phone removed the app / revoked permission
        await env.DB.prepare("DELETE FROM push_subs WHERE endpoint=?").bind(s.endpoint).run();
      } else if (r.ok) {
        sent++;
        await env.DB.prepare("UPDATE push_subs SET last_ok=?, fails=0 WHERE endpoint=?").bind(new Date().toISOString(), s.endpoint).run();
      } else {
        await env.DB.prepare("UPDATE push_subs SET fails=fails+1 WHERE endpoint=?").bind(s.endpoint).run();
        await env.DB.prepare("DELETE FROM push_subs WHERE endpoint=? AND fails>=5").bind(s.endpoint).run();
      }
    } catch (_) { /* network blip: try again on the next print */ }
  }
  return sent;
}

// After the newest prints are copied: if a print newer than the last one we pushed for is in, push once.
async function maybePush(env) {
  if (!env.VAPID_PRIVATE_JWK) return;
  await ensurePushTable(env);
  const top = await env.DB.prepare("SELECT MAX(at) m FROM prints WHERE error IS NULL").first();
  const newest = top && top.m;
  if (!newest) return;
  const hwm = await getMeta(env, "push_hwm");
  if (hwm === null) { await setMeta(env, "push_hwm", newest); return; }   // first run: don't announce old history
  if (newest <= hwm) return;
  await setMeta(env, "push_hwm", newest);                                 // set first so a slow push can't double-send
  await pushAll(env);
}

export async function sync(env) {
  const result = { ok: false, copied: 0, images: 0 };
  try {
    // 1) newest prints, every run
    const first = await fetchLog(env, 0);
    result.copied += await upsertPage(env, first.log || []);
    await setMeta(env, "pi_total", first.total ?? "");

    // 1b) tell subscribed phones if something new arrived (never lets a push problem break the sync)
    try { await maybePush(env); } catch (e) { await setMeta(env, "push_error", (e && e.message) || String(e)); }

    // 2) walk older history until it has all been copied
    if ((await getMeta(env, "backfill_done")) !== "1") {
      let off = parseInt((await getMeta(env, "backfill_offset")) || String(PAGE), 10);
      for (let i = 0; i < BACKFILL_PAGES; i++) {
        const page = await fetchLog(env, off);
        const list = page.log || [];
        if (!list.length) { await setMeta(env, "backfill_done", "1"); break; }
        result.copied += await upsertPage(env, list);
        off += PAGE;
        await setMeta(env, "backfill_offset", off);
      }
    }

    // 3) copy pictures we don't have yet (a few per run)
    const missing = await env.DB.prepare(
      "SELECT DISTINCT photo_id FROM prints WHERE photo_id IS NOT NULL AND photo_id NOT IN (SELECT id FROM images) LIMIT ?"
    ).bind(IMAGES_PER_RUN).all();
    const now = new Date().toISOString();
    const ins = env.DB.prepare("INSERT OR REPLACE INTO images (id,data,bytes,synced_at) VALUES (?,?,?,?)");
    const rows = [];
    for (const m of missing.results || []) {
      const r = await piGet(env, "/api/photo/" + encodeURIComponent(m.photo_id));
      if (r.status === 404) { rows.push(ins.bind(m.photo_id, "", 0, now)); continue; }   // gone from the Pi: remember so we don't retry forever
      if (!r.ok) continue;
      const buf = await r.arrayBuffer();
      if (buf.byteLength > 1_500_000) { rows.push(ins.bind(m.photo_id, "", 0, now)); continue; }   // stay under D1's 2 MB row limit
      rows.push(ins.bind(m.photo_id, bytesToB64(buf), buf.byteLength, now));
    }
    if (rows.length) await env.DB.batch(rows);
    result.images = rows.length;

    result.ok = true;
    await setMeta(env, "last_sync", now);
    await setMeta(env, "last_error", "");
  } catch (e) {
    await setMeta(env, "last_error", (e && e.message) || String(e));
    result.error = (e && e.message) || String(e);
  }
  return result;
}

// What the archive page shows for one print (text only; art tokens become small labels or are dropped).
function shapeLines(lines) {
  const out = [];
  for (const l of lines || []) {
    const [t, st] = Array.isArray(l) ? [String(l[0]), String(l[1] || "body")] : [String(l), "body"];
    if (st === "art") {
      if (t.startsWith("to:")) out.push({ s: "to", t: t.slice(3) });
      continue;     // header, rule, patch, photo: handled elsewhere
    }
    out.push({ s: st, t });
  }
  return out;
}

// POST /push/subscribe | /push/unsubscribe | /push/test   (body: {"endpoint": "..."} as text/plain JSON)
async function handlePush(request, env, url, cors) {
  if (!env.VAPID_PRIVATE_JWK) return json({ ok: false, error: "push is not set up on the server yet" }, 503, cors);
  let body = {};
  try { const t = await request.text(); if (t.length > 4000) throw new Error("big"); body = JSON.parse(t || "{}"); }
  catch (_) { return json({ ok: false, error: "bad request" }, 400, cors); }
  const endpoint = String(body.endpoint || "");
  let host = "";
  try { const u = new URL(endpoint); if (u.protocol !== "https:") throw new Error("scheme"); host = u.hostname; }
  catch (_) { return json({ ok: false, error: "bad endpoint" }, 400, cors); }
  if (endpoint.length > 1000 || !PUSH_HOSTS.some(rx => rx.test(host))) return json({ ok: false, error: "unsupported push service" }, 400, cors);

  await ensurePushTable(env);
  const path = url.pathname;
  if (path === "/push/subscribe") {
    const have = await env.DB.prepare("SELECT 1 x FROM push_subs WHERE endpoint=?").bind(endpoint).first();
    if (!have) {
      const n = (await env.DB.prepare("SELECT COUNT(*) c FROM push_subs").first()).c;
      if (n >= MAX_SUBS) return json({ ok: false, error: "subscriber limit reached" }, 429, cors);
      await env.DB.prepare("INSERT INTO push_subs (endpoint, created_at) VALUES (?,?)").bind(endpoint, new Date().toISOString()).run();
    }
    return json({ ok: true }, 200, cors);
  }
  if (path === "/push/unsubscribe") {
    await env.DB.prepare("DELETE FROM push_subs WHERE endpoint=?").bind(endpoint).run();
    return json({ ok: true }, 200, cors);
  }
  if (path === "/push/test") {
    const have = await env.DB.prepare("SELECT 1 x FROM push_subs WHERE endpoint=?").bind(endpoint).first();
    if (!have) return json({ ok: false, error: "not subscribed" }, 404, cors);
    const last = Number(await getMeta(env, "push_test_at")) || 0;
    if (Date.now() - last < 10000) return json({ ok: false, error: "wait a few seconds" }, 429, cors);
    await setMeta(env, "push_test_at", Date.now());
    const r = await sendPush(env, endpoint);
    if (r.status === 404 || r.status === 410) { await env.DB.prepare("DELETE FROM push_subs WHERE endpoint=?").bind(endpoint).run(); return json({ ok: false, error: "subscription expired, turn it off and on again" }, 410, cors); }
    return json({ ok: r.ok, status: r.status }, r.ok ? 200 : 502, cors);
  }
  return json({ error: "Not found" }, 404, cors);
}

async function handle(request, env) {
  const url = new URL(request.url);
  const cors = corsHeaders(request, env);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...cors, "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "content-type" } });
  if (request.method === "POST" && url.pathname.startsWith("/push/")) return handlePush(request, env, url, cors);
  if (request.method !== "GET") return json({ error: "Not found" }, 404, cors);

  if (url.pathname === "/prints") {
    const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "30", 10) || 30));
    const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10) || 0);
    const order = url.searchParams.get("order") === "old" ? "ASC" : "DESC";
    const kind = url.searchParams.get("kind");
    const q = (url.searchParams.get("q") || "").trim().slice(0, 80);
    const where = ["error IS NULL"];
    const args = [];
    if (kind === "photo") where.push("photo_id IS NOT NULL");
    if (kind === "text") where.push("photo_id IS NULL");
    if (q) { where.push("(msg LIKE ? OR to_name LIKE ? OR from_name LIKE ?)"); const like = "%" + q.replace(/[%_]/g, "") + "%"; args.push(like, like, like); }
    const W = "WHERE " + where.join(" AND ");
    const total = (await env.DB.prepare(`SELECT COUNT(*) c FROM prints ${W}`).bind(...args).first()).c;
    const rows = await env.DB.prepare(
      `SELECT id,at,to_name,from_name,msg,theme,up,lines,photo_id FROM prints ${W} ORDER BY at ${order} LIMIT ? OFFSET ?`
    ).bind(...args, limit, offset).all();
    const prints = (rows.results || []).map(r => {
      let lines = []; try { lines = JSON.parse(r.lines || "[]"); } catch (_) {}
      return { id: r.id, at: r.at, to: r.to_name, from: r.from_name, msg: r.msg, theme: r.theme, up: r.up, photo: r.photo_id, lines: shapeLines(lines) };
    });
    return json({ total, prints }, 200, { ...cors, "cache-control": "public, max-age=60" });
  }

  if (url.pathname.startsWith("/image/")) {
    const id = url.pathname.slice(7);
    if (!/^[0-9a-f]{12}$/.test(id)) return json({ error: "Not found" }, 404, cors);
    const row = await env.DB.prepare("SELECT data FROM images WHERE id=?").bind(id).first();
    if (!row || !row.data) return json({ error: "Not found" }, 404, cors);
    return new Response(b64ToBytes(row.data), { headers: { "content-type": "image/png", "cache-control": "public, max-age=31536000, immutable", ...cors } });
  }

  if (url.pathname === "/status") {
    const c = await env.DB.prepare("SELECT (SELECT COUNT(*) FROM prints) AS prints, (SELECT COUNT(*) FROM images WHERE bytes>0) AS images, (SELECT COALESCE(SUM(bytes),0) FROM images) AS image_bytes").first();
    return json({
      prints: c.prints, images: c.images, image_mb: Math.round(c.image_bytes / 10000) / 100,
      pi_total: await getMeta(env, "pi_total"), last_sync: await getMeta(env, "last_sync"),
      history_complete: (await getMeta(env, "backfill_done")) === "1", last_error: (await getMeta(env, "last_error")) || null,
      limit_note: "D1 free plan: 500 MB per database",
    }, 200, { ...cors, "cache-control": "no-store" });
  }

  return json({ error: "Not found" }, 404, cors);
}

export default {
  async fetch(request, env) {
    try { return await handle(request, env); }
    catch (e) { return json({ error: "Something went wrong" }, 500); }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sync(env));
  },
};
