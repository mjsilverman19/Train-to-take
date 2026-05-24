import GtfsRealtimeBindings from 'gtfs-realtime-bindings';

// ===========================================================================
// CONFIG — tune these after a few real trips. Everything commute-specific
// lives here so you can tweak from a phone without reading the rest.
// ===========================================================================
const CONFIG = {
  // --- Walking times (minutes, door-to-turnstile-to-door) -----------------
  WALK_TO_LEX_86: 8,        // 314 E 82nd St → 86 St (Lex) entrance
  WALK_TO_2AV_86: 2,        // 314 E 82nd St → 86 St (2 Av) entrance
  WALK_28ST_LEX_TO_WORK: 3, // 28 St (6) → 245 5th Ave
  WALK_28ST_BMT_TO_WORK: 2, // 28 St (R/W) → 245 5th Ave

  // --- Ride times (minutes, approximate from MTA schedules) ---------------
  RIDE_6_86_TO_28: 15,       // 6 southbound: 86 St → 28 St
  RIDE_Q_86_TO_HERALD: 12,   // Q southbound: 86 St (2 Av) → 34 St-Herald Sq
  RIDE_RW_HERALD_TO_28: 2,   // R/W southbound: 34 St-Herald Sq → 28 St

  // --- Stop IDs -----------------------------------------------------------
  // NYCT GTFS stops have an N/S suffix for direction (e.g. 626 → 626S).
  // Verified against MTA stops.txt: 626=86 St Lex, Q04=86 St 2 Av,
  // R17=Herald Sq, 633=28 St Lex, R18=28 St BMT.
  STOP_6_LEX_86_S: '626S',  // 86 St (Lexington Av) southbound — 6 train
  STOP_6_LEX_28_S: '633S',  // 28 St (Lexington Av) southbound — destination check
  STOP_Q_86_2AV_S: 'Q04S',  // 86 St (2nd Av) southbound — Q train
  STOP_RW_HERALD_S: 'R17S', // 34 St-Herald Sq southbound — R/W
  STOP_RW_28_S: 'R18S',     // 28 St (Broadway) southbound — destination check

  // --- MTA GTFS-Realtime feeds (no API key required as of 2024) -----------
  // Verify current URLs at https://api.mta.info/#/subwayRealTimeFeeds
  FEED_IRT: 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs',        // 1/2/3/4/5/6/7
  FEED_NQRW: 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-nqrw',  // N/Q/R/W

  // --- Behavior -----------------------------------------------------------
  WINDOW_MIN: 30,              // ignore arrivals this far in the future
  FALLBACK_RW_WAIT_MIN: 4,     // assume this if no realtime R/W data yet
  // 4 and 5 are included because on weekends/track work they sometimes
  // run on the Lex local and stop at 86 St and 28 St. The dest-stop check
  // in upcomingArrivals ensures we don't include them when they're express.
  ROUTES_OPTION_A: ['6', '4', '5'],
  ROUTES_OPTION_B_LEG1: ['Q'],
  ROUTES_OPTION_B_LEG2: ['R', 'W'],
};

// ===========================================================================

const { FeedMessage } = GtfsRealtimeBindings.transit_realtime;

async function fetchFeed(url) {
  const res = await fetch(url, { cf: { cacheTtl: 10, cacheEverything: true } });
  if (!res.ok) throw new Error(`feed ${url} → HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  return FeedMessage.decode(new Uint8Array(buf));
}

// Returns sorted array of {time, routeId} for upcoming arrivals at
// `stopId` on any of `routes`, filtered to [earliestSec, maxSec]. maxSec
// defaults to nowSec + CONFIG.WINDOW_MIN; pass a larger value to look further.
// If `destStopId` is provided, only trips that also stop there are included.
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

function buildOptionA(irtFeed, nowSec) {
  const earliest = nowSec + CONFIG.WALK_TO_LEX_86 * 60;
  const arrivals = upcomingArrivals(
    irtFeed, CONFIG.STOP_6_LEX_86_S, CONFIG.ROUTES_OPTION_A, nowSec, earliest, undefined, CONFIG.STOP_6_LEX_28_S
  );
  const next = arrivals[0];
  if (!next) {
    return unavailableOption('Lex', irtFeed, CONFIG.STOP_6_LEX_86_S, CONFIG.ROUTES_OPTION_A, nowSec, CONFIG.STOP_6_LEX_28_S);
  }
  const nextTrainMinutes = minFromNow(next.time, nowSec);
  const waitAtStation = Math.max(0, nextTrainMinutes - CONFIG.WALK_TO_LEX_86);
  const totalMinutes = CONFIG.WALK_TO_LEX_86 + waitAtStation + CONFIG.RIDE_6_86_TO_28 + CONFIG.WALK_28ST_LEX_TO_WORK;
  return {
    label: 'Lex',
    route: next.routeId,
    totalMinutes,
    nextTrainMinutes,
    legs: [
      { label: 'walk', minutes: CONFIG.WALK_TO_LEX_86 },
      { label: 'wait', minutes: waitAtStation },
      { label: next.routeId, minutes: CONFIG.RIDE_6_86_TO_28 },
      { label: 'walk', minutes: CONFIG.WALK_28ST_LEX_TO_WORK },
    ],
    breakdown: {
      walkToStation: CONFIG.WALK_TO_LEX_86,
      waitAtStation,
      ride: CONFIG.RIDE_6_86_TO_28,
      walkToWork: CONFIG.WALK_28ST_LEX_TO_WORK,
    },
  };
}

function buildOptionB(nqrwFeed, nowSec) {
  const earliestQ = nowSec + CONFIG.WALK_TO_2AV_86 * 60;
  const qArrivals = upcomingArrivals(nqrwFeed, CONFIG.STOP_Q_86_2AV_S, CONFIG.ROUTES_OPTION_B_LEG1, nowSec, earliestQ);
  const nextQ = qArrivals[0];
  if (!nextQ) return unavailableOption('Q+R/W', nqrwFeed, CONFIG.STOP_Q_86_2AV_S, CONFIG.ROUTES_OPTION_B_LEG1, nowSec);

  const qArrivesAtHerald = nextQ.time + CONFIG.RIDE_Q_86_TO_HERALD * 60;
  const rwArrivals = upcomingArrivals(
    nqrwFeed, CONFIG.STOP_RW_HERALD_S, CONFIG.ROUTES_OPTION_B_LEG2, nowSec, qArrivesAtHerald, undefined, CONFIG.STOP_RW_28_S
  );
  const nextRW = rwArrivals[0];

  const nextTrainMinutes = minFromNow(nextQ.time, nowSec);
  const waitForQ = Math.max(0, nextTrainMinutes - CONFIG.WALK_TO_2AV_86);
  let waitForRW;
  let rwRealtime;
  let rwRoute;
  if (nextRW) {
    waitForRW = Math.max(0, Math.round((nextRW.time - qArrivesAtHerald) / 60));
    rwRealtime = true;
    rwRoute = nextRW.routeId;
  } else {
    waitForRW = CONFIG.FALLBACK_RW_WAIT_MIN;
    rwRealtime = false;
    rwRoute = 'R/W';
  }

  const totalMinutes =
    CONFIG.WALK_TO_2AV_86 +
    waitForQ +
    CONFIG.RIDE_Q_86_TO_HERALD +
    waitForRW +
    CONFIG.RIDE_RW_HERALD_TO_28 +
    CONFIG.WALK_28ST_BMT_TO_WORK;

  return {
    label: 'Q+R/W',
    route: `${nextQ.routeId}+${rwRoute}`,
    totalMinutes,
    nextTrainMinutes,
    legs: [
      { label: 'walk', minutes: CONFIG.WALK_TO_2AV_86 },
      { label: 'wait', minutes: waitForQ },
      { label: nextQ.routeId, minutes: CONFIG.RIDE_Q_86_TO_HERALD },
      { label: 'Herald', minutes: waitForRW },
      { label: rwRoute, minutes: CONFIG.RIDE_RW_HERALD_TO_28 },
      { label: 'walk', minutes: CONFIG.WALK_28ST_BMT_TO_WORK },
    ],
    breakdown: {
      walkToStation: CONFIG.WALK_TO_2AV_86,
      waitForQ,
      rideQ: CONFIG.RIDE_Q_86_TO_HERALD,
      waitForRW,
      rideRW: CONFIG.RIDE_RW_HERALD_TO_28,
      walkToWork: CONFIG.WALK_28ST_BMT_TO_WORK,
      realtimeRW: rwRealtime,
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
  if (winner.label === 'Lex') {
    const heraldNote = loser.breakdown.waitForRW > 0
      ? `, ${loser.breakdown.waitForRW} min wait at Herald`
      : '';
    return `${winRoute} in ${winner.nextTrainMinutes} min beats ${loseRoute} (next Q in ${loser.nextTrainMinutes} min${heraldNote})`;
  }
  return `${winRoute} gets you there ${saved} min sooner (next Q in ${winner.nextTrainMinutes} min, next ${loser.route || 'Lex'} in ${loser.nextTrainMinutes} min)`;
}

async function compute() {
  const nowSec = Math.floor(Date.now() / 1000);
  const [irtResult, nqrwResult] = await Promise.allSettled([
    fetchFeed(CONFIG.FEED_IRT),
    fetchFeed(CONFIG.FEED_NQRW),
  ]);

  const irtOk = irtResult.status === 'fulfilled';
  const nqrwOk = nqrwResult.status === 'fulfilled';

  const optionA = irtOk
    ? buildOptionA(irtResult.value, nowSec)
    : { label: 'Lex', unavailable: true, reason: 'IRT feed (1/2/3/4/5/6/7) failed — try again in a minute' };
  const optionB = nqrwOk
    ? buildOptionB(nqrwResult.value, nowSec)
    : { label: 'Q+R/W', unavailable: true, reason: 'NQRW feed failed — try again in a minute' };
  const options = [optionA, optionB];
  const valid = options.filter((o) => !o.unavailable);

  const fetchedAt = new Date().toISOString();
  const degraded = !irtOk || !nqrwOk;

  if (valid.length === 0) {
    return {
      status: 502,
      body: {
        recommendation: null,
        reason: degraded
          ? 'Both MTA feeds failed — try again in a minute'
          : 'No trains in either option right now',
        options,
        fetchedAt,
        degraded,
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
      options,
      fetchedAt,
      degraded,
    },
  };
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

function renderHtml({ recommendation, reason, options, fetchedAt, degraded }) {
  const winner = recommendation && options.find((o) => o.label === recommendation);
  const displayLabel = winner ? (winner.route || winner.label) : '';
  const headline = winner ? `Take the ${displayLabel}` : 'No trains';
  const stats = winner
    ? `${winner.nextTrainMinutes} min to train · ${winner.totalMinutes} min total`
    : '';
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
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#111111" media="(prefers-color-scheme: dark)">
<title>${esc(headline)}</title>
<style>
:root { color-scheme: light dark; }
html, body { margin: 0; min-height: 100%; }
body {
  font: 400 18px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  display: flex; flex-direction: column; justify-content: center; align-items: center;
  padding: 2.5rem 1.5rem; text-align: center; box-sizing: border-box;
  background: #fff; color: #111;
}
@media (prefers-color-scheme: dark) {
  body { background: #111; color: #f5f5f5; }
}
h1 {
  font-size: clamp(2.5rem, 10vw, 4rem);
  font-weight: 600; letter-spacing: -.03em;
  margin: 0 0 .5rem;
}
.stats { font-variant-numeric: tabular-nums; margin: 0 0 1rem; }
.reason { max-width: 28ch; margin: 0 0 2rem; color: #777; }
.options { width: 100%; max-width: 32rem; margin: 0 0 2rem; }
.option { margin: 0 0 1.25rem; }
.option h2 {
  font-size: 1rem; font-weight: 500; margin: 0 0 .25rem;
  letter-spacing: .02em; text-transform: uppercase; color: #888;
}
.option.winner h2 { color: inherit; font-weight: 600; }
.option.unavailable { opacity: .55; }
.option.unavailable .legs { font-style: italic; }
.legs {
  font-variant-numeric: tabular-nums;
  margin: 0; color: #aaa;
  word-spacing: .1em;
}
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
<h1>${esc(headline)}</h1>
${stats ? `<p class="stats">${esc(stats)}</p>` : ''}
<p class="reason">${esc(reason)}</p>
${options.length ? `<div class="options">${optionBlocks}</div>` : ''}
<p class="foot">${esc(time)}${degraded ? ' · degraded' : ''}</p>
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
  const result = await compute();
  const key = nyDateKey();
  const promise = env.HISTORY.put(key, JSON.stringify(result.body), {
    expirationTtl: 60 * 60 * 24 * 180,
  });
  if (ctx && ctx.waitUntil) ctx.waitUntil(promise);
  else await promise;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/history') return handleHistory(env);

    const result = await compute();
    if (url.pathname === '/api') {
      return new Response(JSON.stringify(result.body), {
        status: result.status,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      });
    }
    if (url.pathname === '/') {
      return new Response(renderHtml(result.body), {
        status: result.status,
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
    return new Response('Not found', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    // Cron fires at 13:00 and 14:00 UTC daily on weekdays — only one is 9 AM ET
    // depending on DST. Filter to 9 AM ET locally.
    const nyHour = Number(
      new Date().toLocaleString('en-US', {
        timeZone: 'America/New_York', hour: 'numeric', hour12: false,
      })
    );
    if (nyHour !== 9) return;
    await logResult(env, ctx);
  },
};
