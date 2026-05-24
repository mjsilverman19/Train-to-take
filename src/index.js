import GtfsRealtimeBindings from 'gtfs-realtime-bindings';

// ===========================================================================
// CONFIG — feed URLs and behavior knobs that aren't direction-specific.
// Per-trip stuff (stops, walks, ride times) lives in TRIPS below.
// ===========================================================================
const CONFIG = {
  FEED_IRT: 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs',        // 1/2/3/4/5/6/7
  FEED_NQRW: 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-nqrw',  // N/Q/R/W
  WINDOW_MIN: 30,
  FALLBACK_TRANSFER_WAIT_MIN: 4,
};

// ===========================================================================
// TRIPS — one entry per direction. `a` = Lex local; `b` = two-leg (Q+R/W or
// R/W+Q via Herald cross-platform transfer). Stops verified against MTA
// stops.txt: 626/633 = 86/28 St Lex, Q04 = 86 St 2 Av, R17 = Herald BMT,
// R18 = 28 St BMT. N/Q and R/W share R17 (cross-platform).
// ===========================================================================
const TRIPS = {
  work: {
    label: 'to work',
    a: {
      label: 'Lex',
      walkToStation: 8,           // 314 E 82nd → 86 St Lex
      boardStop: '626S',
      destStop: '633S',
      routes: ['6', '4', '5'],
      ride: 15,
      walkFromStation: 3,         // 28 St Lex → 245 5th Ave
    },
    b: {
      label: 'Q+R/W',
      walkToStation: 2,           // 314 E 82nd → 86 St 2 Av
      firstBoardStop: 'Q04S',
      firstRoutes: ['Q'],
      firstRide: 12,
      transferStop: 'R17S',       // Herald SB (BMT)
      secondRoutes: ['R', 'W'],
      secondDestStop: 'R18S',
      secondRide: 2,
      walkFromStation: 2,         // 28 St BMT → 245 5th Ave
    },
  },
  home: {
    label: 'home',
    a: {
      label: 'Lex',
      walkToStation: 3,           // 245 5th Ave → 28 St Lex
      boardStop: '633N',
      destStop: '626N',
      routes: ['6', '4', '5'],
      ride: 15,
      walkFromStation: 8,         // 86 St Lex → 314 E 82nd
    },
    b: {
      label: 'R/W+Q',
      walkToStation: 2,           // 245 5th Ave → 28 St BMT
      firstBoardStop: 'R18N',
      firstRoutes: ['R', 'W'],
      firstRide: 2,
      transferStop: 'R17N',       // Herald NB (BMT)
      secondRoutes: ['Q'],
      secondDestStop: 'Q04N',
      secondRide: 12,
      walkFromStation: 2,         // 86 St 2 Av → 314 E 82nd
    },
  },
};

// ===========================================================================

const { FeedMessage } = GtfsRealtimeBindings.transit_realtime;

async function fetchFeed(url) {
  const res = await fetch(url, { cf: { cacheTtl: 10, cacheEverything: true } });
  if (!res.ok) throw new Error(`feed ${url} → HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  return FeedMessage.decode(new Uint8Array(buf));
}

// Returns sorted array of {time, routeId} for upcoming arrivals at `stopId`
// on any of `routes`, filtered to [earliestSec, maxSec]. maxSec defaults to
// nowSec + CONFIG.WINDOW_MIN; pass a larger value to look further. If
// `destStopId` is provided, only trips that also stop there are included.
function upcomingArrivals(feed, stopId, routes, nowSec, earliestSec, maxSec, destStopId) {
  const out = [];
  const ceiling = maxSec ?? (nowSec + CONFIG.WINDOW_MIN * 60);
  const floor = earliestSec ?? nowSec;
  for (const entity of feed.entity || []) {
    const tu = entity.tripUpdate;
    if (!tu) continue;
    const routeId = tu.trip && tu.trip.routeId;
    if (!routes.includes(routeId)) continue;
    const stus = tu.stopTimeUpdate || [];
    if (destStopId && !stus.some((s) => s.stopId === destStopId)) continue;
    for (const stu of stus) {
      if (stu.stopId !== stopId) continue;
      const raw = (stu.arrival && stu.arrival.time) || (stu.departure && stu.departure.time);
      if (!raw) continue;
      const t = typeof raw === 'number' ? raw : Number(raw);
      if (!t || t < floor || t > ceiling) continue;
      out.push({ time: t, routeId });
    }
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

const minFromNow = (sec, nowSec) => Math.max(0, Math.round((sec - nowSec) / 60));

function unavailableOption(label, feed, stopId, routes, nowSec, destStopId) {
  const far = upcomingArrivals(feed, stopId, routes, nowSec, nowSec, nowSec + 120 * 60, destStopId);
  const name = label.split('+')[0];
  return {
    label,
    unavailable: true,
    reason: far[0]
      ? `next ${name} not for ${minFromNow(far[0].time, nowSec)} min — beyond ${CONFIG.WINDOW_MIN}-min window`
      : `no ${name} trains found at the stop in the next 2 hrs — likely a service change`,
  };
}

function buildOptionA(irtFeed, nowSec, a) {
  const earliest = nowSec + a.walkToStation * 60;
  const arrivals = upcomingArrivals(irtFeed, a.boardStop, a.routes, nowSec, earliest, undefined, a.destStop);
  const next = arrivals[0];
  if (!next) return unavailableOption(a.label, irtFeed, a.boardStop, a.routes, nowSec, a.destStop);
  const nextTrainMinutes = minFromNow(next.time, nowSec);
  const waitAtStation = Math.max(0, nextTrainMinutes - a.walkToStation);
  const totalMinutes = a.walkToStation + waitAtStation + a.ride + a.walkFromStation;
  return {
    label: a.label,
    route: next.routeId,
    totalMinutes,
    nextTrainMinutes,
    legs: [
      { label: 'walk', minutes: a.walkToStation },
      { label: 'wait', minutes: waitAtStation },
      { label: next.routeId, minutes: a.ride },
      { label: 'walk', minutes: a.walkFromStation },
    ],
    breakdown: { walkToStation: a.walkToStation, waitAtStation, ride: a.ride, walkToDest: a.walkFromStation },
  };
}

function buildOptionB(nqrwFeed, nowSec, b) {
  const earliestFirst = nowSec + b.walkToStation * 60;
  const firstArrivals = upcomingArrivals(nqrwFeed, b.firstBoardStop, b.firstRoutes, nowSec, earliestFirst);
  const nextFirst = firstArrivals[0];
  if (!nextFirst) return unavailableOption(b.label, nqrwFeed, b.firstBoardStop, b.firstRoutes, nowSec);

  const arrivesAtTransfer = nextFirst.time + b.firstRide * 60;
  const secondArrivals = upcomingArrivals(
    nqrwFeed, b.transferStop, b.secondRoutes, nowSec, arrivesAtTransfer, undefined, b.secondDestStop
  );
  const nextSecond = secondArrivals[0];

  const nextTrainMinutes = minFromNow(nextFirst.time, nowSec);
  const waitForFirst = Math.max(0, nextTrainMinutes - b.walkToStation);
  let waitForSecond;
  let secondRealtime;
  let secondRoute;
  if (nextSecond) {
    waitForSecond = Math.max(0, Math.round((nextSecond.time - arrivesAtTransfer) / 60));
    secondRealtime = true;
    secondRoute = nextSecond.routeId;
  } else {
    waitForSecond = CONFIG.FALLBACK_TRANSFER_WAIT_MIN;
    secondRealtime = false;
    secondRoute = b.secondRoutes.join('/');
  }

  const totalMinutes =
    b.walkToStation + waitForFirst + b.firstRide + waitForSecond + b.secondRide + b.walkFromStation;

  return {
    label: b.label,
    route: `${nextFirst.routeId}+${secondRoute}`,
    totalMinutes,
    nextTrainMinutes,
    legs: [
      { label: 'walk', minutes: b.walkToStation },
      { label: 'wait', minutes: waitForFirst },
      { label: nextFirst.routeId, minutes: b.firstRide },
      { label: 'Herald', minutes: waitForSecond },
      { label: secondRoute, minutes: b.secondRide },
      { label: 'walk', minutes: b.walkFromStation },
    ],
    breakdown: {
      walkToStation: b.walkToStation,
      waitForFirst,
      firstRide: b.firstRide,
      waitForSecond,
      secondRide: b.secondRide,
      walkToDest: b.walkFromStation,
      realtimeTransfer: secondRealtime,
    },
  };
}

function buildReason(winner, loser, allOptions) {
  if (!loser) {
    const unavailable = (allOptions || []).find((o) => o.unavailable);
    return unavailable
      ? `${winner.label} in ${winner.nextTrainMinutes} min — ${unavailable.label}: ${unavailable.reason}`
      : `${winner.label} in ${winner.nextTrainMinutes} min`;
  }
  const saved = loser.totalMinutes - winner.totalMinutes;
  const winRoute = winner.route || winner.label;
  const loseRoute = loser.route || loser.label;
  if (saved === 0) return `${winRoute} ties ${loseRoute} (${winner.totalMinutes} min either way)`;
  return `${winRoute} beats ${loseRoute} by ${saved} min`;
}

function computeForTrip(trip, irtResult, nqrwResult, nowSec) {
  const irtOk = irtResult.status === 'fulfilled';
  const nqrwOk = nqrwResult.status === 'fulfilled';
  const optionA = irtOk
    ? buildOptionA(irtResult.value, nowSec, trip.a)
    : { label: trip.a.label, unavailable: true, reason: 'IRT feed failed — try again in a minute' };
  const optionB = nqrwOk
    ? buildOptionB(nqrwResult.value, nowSec, trip.b)
    : { label: trip.b.label, unavailable: true, reason: 'NQRW feed failed — try again in a minute' };
  const options = [optionA, optionB];
  const valid = options.filter((o) => !o.unavailable);
  const fetchedAt = new Date().toISOString();
  const degraded = !irtOk || !nqrwOk;

  if (valid.length === 0) {
    return {
      status: 502,
      body: {
        recommendation: null,
        reason: degraded ? 'Both MTA feeds failed — try again in a minute' : 'No trains in either option right now',
        options, fetchedAt, degraded,
      },
    };
  }
  const winner = valid.reduce((a, b) => (a.totalMinutes <= b.totalMinutes ? a : b));
  const loser = valid.find((o) => o !== winner) || null;
  return {
    status: 200,
    body: {
      recommendation: winner.label,
      reason: buildReason(winner, loser, options),
      options, fetchedAt, degraded,
    },
  };
}

async function compute(trip) {
  const nowSec = Math.floor(Date.now() / 1000);
  const [irtResult, nqrwResult] = await Promise.allSettled([
    fetchFeed(CONFIG.FEED_IRT),
    fetchFeed(CONFIG.FEED_NQRW),
  ]);
  return computeForTrip(trip, irtResult, nqrwResult, nowSec);
}

async function computeBoth() {
  const nowSec = Math.floor(Date.now() / 1000);
  const [irtResult, nqrwResult] = await Promise.allSettled([
    fetchFeed(CONFIG.FEED_IRT),
    fetchFeed(CONFIG.FEED_NQRW),
  ]);
  return {
    work: computeForTrip(TRIPS.work, irtResult, nqrwResult, nowSec),
    home: computeForTrip(TRIPS.home, irtResult, nqrwResult, nowSec),
  };
}

function nyHour(date = new Date()) {
  return Number(date.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }));
}

function defaultDirection(date = new Date()) {
  return nyHour(date) >= 14 ? 'home' : 'work';
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function renderLegs(legs) {
  return legs.map((l) => `${esc(l.label)} ${l.minutes}m`).join(' → ');
}

function renderOption(opt, isWinner) {
  const display = opt.route || opt.label;
  if (opt.unavailable) {
    return `<section class="option unavailable">
  <h2>via ${esc(display)} · —</h2>
  <p class="legs">${esc(opt.reason || 'unavailable')}</p>
</section>`;
  }
  return `<section class="option${isWinner ? ' winner' : ''}">
  <h2>via ${esc(display)} · ${opt.totalMinutes} min</h2>
  <p class="legs">${renderLegs(opt.legs || [])}</p>
</section>`;
}

function renderTripBody({ recommendation, reason, options, fetchedAt, degraded }) {
  const winner = recommendation && options.find((o) => o.label === recommendation);
  const displayLabel = winner ? (winner.route || winner.label) : '';
  const headline = winner ? `Take the ${displayLabel}` : 'No trains';
  const stats = winner ? `${winner.nextTrainMinutes} min to train · ${winner.totalMinutes} min total` : '';
  const time = new Date(fetchedAt).toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York',
  });
  const optionBlocks = options
    .slice()
    .sort((a, b) => {
      if (a.label === recommendation) return -1;
      if (b.label === recommendation) return 1;
      if (a.unavailable && !b.unavailable) return 1;
      if (!a.unavailable && b.unavailable) return -1;
      return 0;
    })
    .map((o) => renderOption(o, o.label === recommendation))
    .join('\n');
  return `<h1>${esc(headline)}</h1>
${stats ? `<p class="stats">${esc(stats)}</p>` : ''}
<p class="reason">${esc(reason)}</p>
${options.length ? `<div class="options">${optionBlocks}</div>` : ''}
<p class="foot">${esc(time)}${degraded ? ' · degraded' : ''}</p>`;
}

function renderPage(workBody, homeBody, defaultDir) {
  const winner = (defaultDir === 'work' ? workBody : homeBody);
  const displayLabel = winner.recommendation
    ? (winner.options.find((o) => o.label === winner.recommendation)?.route || winner.recommendation)
    : '';
  const title = winner.recommendation ? `Take the ${displayLabel}` : 'No trains';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#111111" media="(prefers-color-scheme: dark)">
<title>${esc(title)}</title>
<style>
:root { color-scheme: light dark; }
html, body { margin: 0; min-height: 100%; }
body {
  font: 400 18px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  display: flex; flex-direction: column; align-items: center;
  padding: 1.25rem 1.5rem 2.5rem; box-sizing: border-box; min-height: 100vh;
  background: #fff; color: #111;
}
@media (prefers-color-scheme: dark) {
  body { background: #111; color: #f5f5f5; }
}
input[name="dir"] { position: fixed; left: -9999px; }
.toggle {
  display: flex; gap: .25rem; margin: 0 0 2rem;
  font-size: .75rem; letter-spacing: .08em; text-transform: uppercase;
}
.toggle label {
  cursor: pointer; padding: .4rem .9rem; border-radius: 999px;
  color: #999; transition: color .15s, background .15s;
}
#dir-work:checked ~ .toggle label[for="dir-work"],
#dir-home:checked ~ .toggle label[for="dir-home"] {
  color: inherit; background: rgba(0,0,0,.06);
}
@media (prefers-color-scheme: dark) {
  #dir-work:checked ~ .toggle label[for="dir-work"],
  #dir-home:checked ~ .toggle label[for="dir-home"] { background: rgba(255,255,255,.08); }
}
.trip { display: none; flex: 1; flex-direction: column; justify-content: center; align-items: center; text-align: center; width: 100%; }
#dir-work:checked ~ .trip.work,
#dir-home:checked ~ .trip.home { display: flex; }
h1 { font-size: clamp(2.5rem, 10vw, 4rem); font-weight: 600; letter-spacing: -.03em; margin: 0 0 .5rem; }
.stats { font-variant-numeric: tabular-nums; margin: 0 0 1rem; }
.reason { max-width: 28ch; margin: 0 0 2rem; color: #777; }
.options { width: 100%; max-width: 32rem; margin: 0 0 2rem; }
.option { margin: 0 0 1.25rem; }
.option h2 { font-size: 1rem; font-weight: 500; margin: 0 0 .25rem; letter-spacing: .02em; text-transform: uppercase; color: #888; }
.option.winner h2 { color: inherit; font-weight: 600; }
.option.unavailable { opacity: .55; }
.option.unavailable .legs { font-style: italic; }
.legs { font-variant-numeric: tabular-nums; margin: 0; color: #aaa; word-spacing: .1em; }
.option.winner .legs { color: inherit; }
.foot { font-size: .8rem; color: #999; margin: 0; }
@media (prefers-color-scheme: dark) {
  .reason { color: #aaa; }
  .option h2 { color: #666; }
  .legs { color: #666; }
  .foot { color: #777; }
}
</style>
</head>
<body>
<input type="radio" name="dir" id="dir-work"${defaultDir === 'work' ? ' checked' : ''}>
<input type="radio" name="dir" id="dir-home"${defaultDir === 'home' ? ' checked' : ''}>
<nav class="toggle">
  <label for="dir-work">→ work</label>
  <label for="dir-home">← home</label>
</nav>
<div class="trip work">
${renderTripBody(workBody)}
</div>
<div class="trip home">
${renderTripBody(homeBody)}
</div>
</body>
</html>`;
}

function nyDateKey(date = new Date()) {
  return date.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function formatHistoryDate(yyyyMmDd) {
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC',
  });
}

function renderHistoryHtml(entries, message) {
  const body = entries.length
    ? `<table>
<thead><tr><th>Date</th><th>Pick</th><th>Lex</th><th>Q+R/W</th></tr></thead>
<tbody>
${entries.map((e) => {
  const d = e.data;
  if (!d) return `<tr><td>${esc(formatHistoryDate(e.date))}</td><td colspan="3" class="muted">no data</td></tr>`;
  const cell = (label) => {
    const o = d.options.find((opt) => opt.label === label);
    if (!o || o.unavailable) return '—';
    return `${o.totalMinutes}m`;
  };
  const winner = d.recommendation ? d.options.find((o) => o.label === d.recommendation) : null;
  const pick = winner ? (winner.route || winner.label) : '—';
  return `<tr>
  <td>${esc(formatHistoryDate(e.date))}</td>
  <td>${esc(pick)}</td>
  <td>${esc(cell('Lex'))}</td>
  <td>${esc(cell('Q+R/W'))}</td>
</tr>`;
}).join('\n')}
</tbody>
</table>`
    : `<p class="muted">${esc(message || 'No entries yet — cron logs once per weekday at 9 AM ET.')}</p>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>history · 9 AM ET</title>
<style>
:root { color-scheme: light dark; }
body {
  font: 400 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  max-width: 30rem; margin: 0 auto; padding: 2rem 1.5rem;
  background: #fff; color: #111;
}
@media (prefers-color-scheme: dark) {
  body { background: #111; color: #f5f5f5; }
}
h1 { font-size: 1.25rem; font-weight: 600; letter-spacing: -.01em; margin: 0 0 1.25rem; }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: .5rem .25rem; border-bottom: 1px solid #eee; }
@media (prefers-color-scheme: dark) { th, td { border-color: #2a2a2a; } }
th { font-weight: 500; color: #888; font-size: .75rem; text-transform: uppercase; letter-spacing: .04em; }
.muted { color: #888; }
.back { font-size: .9rem; color: #888; margin-top: 1.5rem; }
a { color: inherit; }
</style>
</head>
<body>
<h1>history · 9 AM ET</h1>
${body}
<p class="back"><a href="/">← back</a></p>
</body>
</html>`;
}

async function handleHistory(env) {
  const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
  if (!env || !env.HISTORY) {
    return new Response(
      renderHistoryHtml([], 'History storage not configured — KV binding "HISTORY" missing.'),
      { status: 200, headers }
    );
  }
  const list = await env.HISTORY.list({ limit: 90 });
  const entries = await Promise.all(
    list.keys.map(async (k) => ({
      date: k.name,
      data: JSON.parse((await env.HISTORY.get(k.name)) || 'null'),
    }))
  );
  entries.sort((a, b) => b.date.localeCompare(a.date));
  return new Response(renderHistoryHtml(entries), { status: 200, headers });
}

async function logResult(env, ctx) {
  if (!env || !env.HISTORY) return;
  const result = await compute(TRIPS.work);
  const key = nyDateKey();
  const promise = env.HISTORY.put(key, JSON.stringify(result.body), {
    expirationTtl: 60 * 60 * 24 * 180,
  });
  if (ctx && ctx.waitUntil) ctx.waitUntil(promise);
  else await promise;
}

function pickTrip(d) {
  if (d === 'work' || d === 'home') return d;
  return defaultDirection();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/history') return handleHistory(env);

    if (url.pathname === '/api') {
      const dir = pickTrip(url.searchParams.get('d'));
      const result = await compute(TRIPS[dir]);
      return new Response(JSON.stringify({ direction: dir, ...result.body }), {
        status: result.status,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      });
    }

    if (url.pathname === '/' || url.pathname === '/home' || url.pathname === '/work') {
      const explicit = url.pathname === '/home' ? 'home' : url.pathname === '/work' ? 'work' : null;
      const dir = explicit || defaultDirection();
      const both = await computeBoth();
      const status = Math.max(both.work.status, both.home.status);
      return new Response(renderPage(both.work.body, both.home.body, dir), {
        status,
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      });
    }

    return new Response('Not found', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    // Cron fires at 13:00 and 14:00 UTC daily on weekdays — only one is 9 AM ET
    // depending on DST. Filter to 9 AM ET locally.
    if (nyHour() !== 9) return;
    await logResult(env, ctx);
  },
};
