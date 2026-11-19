// TechPatraa - Live Cricket Worker (Cloudflare)
// Ek hi "Durable Object" API se data lata hai, aur sabhi visitors ko wahi data baant deta hai.
// Isse API ke hits visitors ki sankhya se nahi badhte, sirf neeche ke PLAN ke hisaab se lagte hain.
// API key code me nahi hai: Worker ke "Secrets" me CRIC_API_KEY naam se rakhni hai.

const PLANS = {
  free: { maxHits: 85,   liveTTL: 1200, idleTTL: 3600, extras: false, extrasTTL: 0,  upEveryH: 12, maxLive: 0, reserve: 5 },
  s:    { maxHits: 1850, liveTTL: 45,   idleTTL: 900,  extras: true,  extrasTTL: 90, upEveryH: 2,  maxLive: 1, reserve: 50 },
  m:    { maxHits: 9500, liveTTL: 10,   idleTTL: 600,  extras: true,  extrasTTL: 20, upEveryH: 1,  maxLive: 2, reserve: 200 }
};

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'content-type': 'application/json; charset=utf-8'
};

/* ---------------- Entry ---------------- */
export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    if (url.pathname !== '/cricket.json' && url.pathname !== '/') {
      return new Response('{"error":"not found"}', { status: 404, headers: CORS });
    }
    // 5 second ka edge cache: bahut visitors aaye to bhi Durable Object par bojh nahi padta
    const cacheKey = new Request(url.origin + '/cricket.json');
    const cache = (typeof caches !== 'undefined') ? caches.default : null;
    if (cache) {
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
    }
    const stub = env.HUB.get(env.HUB.idFromName('main'));
    const res = await stub.fetch(new Request(url.origin + '/cricket.json'));
    const out = new Response(res.body, { status: res.status, headers: { ...CORS, 'cache-control': 'public, max-age=5' } });
    if (cache && res.status === 200) ctx.waitUntil(cache.put(cacheKey, out.clone()));
    return out;
  }
};

/* ---------------- Helpers ---------------- */
function inferType(m) {
  const t = String(m.matchType || '').toUpperCase();
  if (t) return t;
  const n = String(m.name || '');
  if (/\btest\b/i.test(n)) return 'TEST';
  if (/t20/i.test(n)) return 'T20';
  if (/\bodi\b/i.test(n)) return 'ODI';
  return '';
}

function norm(m, now) {
  const info = m.teamInfo || [];
  const names = (m.teams && m.teams.length) ? m.teams : info.map(t => t.name);
  const teams = names.map(n => {
    const ti = info.find(t => t.name === n) || {};
    const scores = (m.score || [])
      .filter(s => String(s.inning || '').toLowerCase().indexOf(String(n).toLowerCase()) === 0)
      .map(s => ({ r: s.r, w: s.w, o: s.o }));
    return { name: n, short: ti.shortname || String(n).slice(0, 3).toUpperCase(), img: ti.img || '', scores };
  });
  const started = !!m.matchStarted, ended = !!m.matchEnded;
  let iso = m.dateTimeGMT || null;
  if (iso && !/Z$/.test(iso)) iso += 'Z';
  const type = inferType(m);
  const maxAge = type === 'TEST' ? 6 * 864e5 : 20 * 36e5;
  const stale = !!(started && !ended && iso && (now - Date.parse(iso)) > maxAge);
  return {
    id: m.id, name: m.name || '', type, status: m.status || '', venue: m.venue || '', start: iso,
    started, ended, live: started && !ended && !stale, stale, teams
  };
}

function normCard(j) {
  const sc = (j.data && j.data.scorecard) || [];
  return sc.map(i => ({
    inning: i.inning || '',
    batting: (i.batting || []).map(b => ({
      name: b.batsman && b.batsman.name, r: b.r, b: b.b, f: b['4s'], s: b['6s'], sr: b.sr,
      out: b['dismissal-text'] || b.dismissal || ''
    })),
    bowling: (i.bowling || []).map(b => ({
      name: b.bowler && b.bowler.name, o: b.o, m: b.m, r: b.r, w: b.w, eco: b.eco
    }))
  }));
}

function normBbb(j) {
  const arr = (j.data && (j.data.bbb || j.data.balls)) || [];
  return arr.slice(-15).reverse().map(b => ({
    over: (b.over !== undefined ? b.over : (b.ball !== undefined ? b.ball : '')),
    text: b.commentary || b.text || b.description || b.score || ''
  })).filter(x => x.text);
}

function hasLive(d) { return !!(d && d.matches && d.matches.some(m => m.live)); }

/* ---------------- Durable Object ---------------- */
export class CricketHub {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.refreshing = null;
  }

  cfg() {
    const p = String((this.env && this.env.PLAN) || 'free').toLowerCase();
    return Object.assign({ plan: PLANS[p] ? p : 'free' }, PLANS[p] || PLANS.free);
  }

  async fetch() {
    const cfg = this.cfg();
    let data = await this.ctx.storage.get('data');
    const now = Date.now();
    const ttl = hasLive(data) ? cfg.liveTTL : cfg.idleTTL;
    const age = (data && data.updated) ? (now - Date.parse(data.updated)) / 1000 : Infinity;
    if (age >= ttl) {
      if (!this.refreshing) {
        this.refreshing = this.refresh(cfg, data).finally(() => { this.refreshing = null; });
      }
      try { data = (await this.refreshing) || data; } catch (e) { /* purana data hi dikhao */ }
    }
    const body = data || { updated: null, matches: [] };
    return new Response(JSON.stringify(body), { headers: CORS });
  }

  async api(path, params, meta) {
    const key = this.env.CRIC_API_KEY;
    if (!key) throw new Error('CRIC_API_KEY set nahi hai');
    const u = new URL('https://api.cricapi.com/v1/' + path);
    u.searchParams.set('apikey', key);
    Object.keys(params || {}).forEach(k => u.searchParams.set(k, params[k]));
    meta.hits++;
    const r = await fetch(u);
    if (!r.ok) throw new Error(path + ' HTTP ' + r.status);
    const j = await r.json();
    if (j.status !== 'success') {
      const why = String(j.reason || j.status || '');
      if (/limit|hits|exceed/i.test(why)) meta.blockedUntil = Date.now() + 30 * 60000;
      throw new Error(path + ' -> ' + why);
    }
    if (j.info) { meta.apiHits = j.info.hitsToday; meta.apiLimit = j.info.hitsLimit; }
    return j;
  }

  async refresh(cfg, prev) {
    const now = Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    let meta = (await this.ctx.storage.get('meta')) || {};
    if (meta.day !== day) meta = { day, hits: 0, upAt: meta.upAt || 0, exAt: 0, blockedUntil: 0 };

    // Din ke hisaab se hits ka budget (UTC din): kul budget se zyada kabhi nahi
    const frac = (now - Date.parse(day + 'T00:00:00Z')) / 864e5;
    const allowed = Math.min(cfg.maxHits - cfg.reserve, cfg.maxHits * (frac + 0.35));
    if (meta.blockedUntil && now < meta.blockedUntil) return prev;
    if (meta.hits >= allowed) return prev;

    try {
      const cur = await this.api('currentMatches', { offset: 0 }, meta);
      const list = (cur.data || []).map(m => norm(m, now));

      let upcoming = [];
      const needUp = !meta.upAt || (now - meta.upAt) / 3600000 >= cfg.upEveryH;
      if (needUp && meta.hits < allowed) {
        try {
          const up = await this.api('matches', { offset: 0 }, meta);
          upcoming = (up.data || []).map(m => norm(m, now)).filter(m => !m.started && m.start && Date.parse(m.start) > now);
          meta.upAt = now;
        } catch (e) { /* upcoming na mile to purani list rakhenge */ }
      }
      if (!upcoming.length && prev && prev.matches) {
        upcoming = prev.matches.filter(m => !m.started && m.start && Date.parse(m.start) > now);
      }

      const seen = {}, all = [];
      list.concat(upcoming).forEach(m => {
        if (m.id && !seen[m.id] && !m.stale && m.teams.length >= 2 && !m.teams.some(t => /^\s*tbc\s*$/i.test(String(t.name)))) {
          seen[m.id] = 1; all.push(m);
        }
      });
      const live = all.filter(m => m.live).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
      const up   = all.filter(m => !m.started && !m.ended).sort((a, b) => Date.parse(a.start) - Date.parse(b.start)).slice(0, 24);
      const done = all.filter(m => m.ended).sort((a, b) => Date.parse(b.start) - Date.parse(a.start)).slice(0, 10);

      // Paid plans: scorecard + ball-by-ball (kam baar, taaki hits bachen)
      let extras = (await this.ctx.storage.get('extras')) || {};
      if (cfg.extras) {
        if (!meta.exAt || (now - meta.exAt) / 1000 >= cfg.extrasTTL) {
          const fresh = {};
          for (const m of live.slice(0, cfg.maxLive)) {
            if (meta.hits >= allowed) break;
            const ex = {};
            try { ex.card = normCard(await this.api('match_scorecard', { id: m.id }, meta)); } catch (e) {}
            if (meta.hits < allowed) {
              try { const b = normBbb(await this.api('match_bbb', { id: m.id }, meta)); if (b.length) ex.bbb = b; } catch (e) {}
            }
            fresh[m.id] = ex;
          }
          extras = fresh;
          meta.exAt = now;
          await this.ctx.storage.put('extras', extras);
        }
        live.forEach(m => { const ex = extras[m.id]; if (ex) { if (ex.card && ex.card.length) m.card = ex.card; if (ex.bbb) m.bbb = ex.bbb; } });
      }

      const ttl = live.length ? cfg.liveTTL : cfg.idleTTL;
      const out = {
        updated: new Date().toISOString(), mode: cfg.plan, refreshSec: ttl, refreshMin: Math.max(1, Math.round(ttl / 60)),
        apiHits: meta.apiHits, apiLimit: meta.apiLimit,
        matches: live.concat(up, done).map(m => { delete m.stale; return m; })
      };
      await this.ctx.storage.put('data', out);
      await this.ctx.storage.put('meta', meta);
      return out;
    } catch (e) {
      await this.ctx.storage.put('meta', meta);
      return prev;
    }
  }
}
