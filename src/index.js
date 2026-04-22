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
  // TODO: verify against MTA's stops.txt before trusting these:
  //   http://web.mta.info/developers/data/nyct/subway/google_transit.zip
  STOP_6_LEX_86_S: '626S',  // 86 St (Lexington Av) southbound — 6 train
  STOP_Q_86_2AV_S: 'Q05S',  // 86 St (2nd Av) southbound — Q train
  STOP_RW_HERALD_S: 'R20S', // 34 St-Herald Sq southbound — R/W (might be R17S; confirm)

  // --- MTA GTFS-Realtime feeds (no API key required as of 2024) -----------
  // Verify current URLs at https://api.mta.info/#/subwayRealTimeFeeds
  FEED_IRT: 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs',        // 1/2/3/4/5/6/7
  FEED_NQRW: 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-nqrw',  // N/Q/R/W

  // --- Behavior -----------------------------------------------------------
  WINDOW_MIN: 30,              // ignore arrivals this far in the future
  FALLBACK_RW_WAIT_MIN: 4,     // assume this if no realtime R/W data yet
  ROUTES_OPTION_A: ['6'],
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

// Returns sorted array of unix-second timestamps for upcoming arrivals at
// `stopId` on any of `routes`, filtered to [earliestSec, nowSec + window].
function upcomingArrivals(feed, stopId, routes, nowSec, earliestSec) {
  const out = [];
  const maxSec = nowSec + CONFIG.WINDOW_MIN * 60;
  const floor = earliestSec ?? nowSec;
  for (const entity of feed.entity || []) {
    const tu = entity.tripUpdate;
    if (!tu) continue;
    const routeId = tu.trip && tu.trip.routeId;
    if (!routes.includes(routeId)) continue;
    for (const stu of tu.stopTimeUpdate || []) {
      if (stu.stopId !== stopId) continue;
      const raw = (stu.arrival && stu.arrival.time) || (stu.departure && stu.departure.time);
      if (!raw) continue;
      const t = typeof raw === 'number' ? raw : Number(raw);
      if (!t || t < floor || t > maxSec) continue;
      out.push(t);
    }
  }
  out.sort((a, b) => a - b);
  return out;
}

const minFromNow = (sec, nowSec) => Math.max(0, Math.round((sec - nowSec) / 60));

function buildOptionA(irtFeed, nowSec) {
  const earliest = nowSec + CONFIG.WALK_TO_LEX_86 * 60;
  const arrivals = upcomingArrivals(irtFeed, CONFIG.STOP_6_LEX_86_S, CONFIG.ROUTES_OPTION_A, nowSec, earliest);
  const next = arrivals[0];
  if (!next) return null;
  const nextTrainMinutes = minFromNow(next, nowSec);
  const waitAtStation = Math.max(0, nextTrainMinutes - CONFIG.WALK_TO_LEX_86);
  const totalMinutes = CONFIG.WALK_TO_LEX_86 + waitAtStation + CONFIG.RIDE_6_86_TO_28 + CONFIG.WALK_28ST_LEX_TO_WORK;
  return {
    label: '6',
    totalMinutes,
    nextTrainMinutes,
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
  if (!nextQ) return null;

  const qArrivesAtHerald = nextQ + CONFIG.RIDE_Q_86_TO_HERALD * 60;
  const rwArrivals = upcomingArrivals(nqrwFeed, CONFIG.STOP_RW_HERALD_S, CONFIG.ROUTES_OPTION_B_LEG2, nowSec, qArrivesAtHerald);
  const nextRW = rwArrivals[0];

  const nextTrainMinutes = minFromNow(nextQ, nowSec);
  const waitForQ = Math.max(0, nextTrainMinutes - CONFIG.WALK_TO_2AV_86);
  let waitForRW;
  let rwRealtime;
  if (nextRW) {
    waitForRW = Math.max(0, Math.round((nextRW - qArrivesAtHerald) / 60));
    rwRealtime = true;
  } else {
    waitForRW = CONFIG.FALLBACK_RW_WAIT_MIN;
    rwRealtime = false;
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
    totalMinutes,
    nextTrainMinutes,
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

function buildReason(winner, loser) {
  if (!loser) return `${winner.label} in ${winner.nextTrainMinutes} min (other feed unavailable)`;
  const saved = loser.totalMinutes - winner.totalMinutes;
  if (winner.label === '6') {
    const heraldNote = loser.breakdown.waitForRW > 0
      ? `, ${loser.breakdown.waitForRW} min wait at Herald`
      : '';
    return `6 in ${winner.nextTrainMinutes} min beats Q+R/W (next Q in ${loser.nextTrainMinutes} min${heraldNote})`;
  }
  return `Q+R/W gets you there ${saved} min sooner (next Q in ${winner.nextTrainMinutes} min, next 6 in ${loser.nextTrainMinutes} min)`;
}

export default {
  async fetch() {
    const nowSec = Math.floor(Date.now() / 1000);
    const [irtResult, nqrwResult] = await Promise.allSettled([
      fetchFeed(CONFIG.FEED_IRT),
      fetchFeed(CONFIG.FEED_NQRW),
    ]);

    const irtOk = irtResult.status === 'fulfilled';
    const nqrwOk = nqrwResult.status === 'fulfilled';

    const options = [];
    if (irtOk) {
      const a = buildOptionA(irtResult.value, nowSec);
      if (a) options.push(a);
    }
    if (nqrwOk) {
      const b = buildOptionB(nqrwResult.value, nowSec);
      if (b) options.push(b);
    }

    const headers = {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    };

    if (options.length === 0) {
      return new Response(JSON.stringify({
        recommendation: null,
        reason: irtOk || nqrwOk
          ? 'No upcoming trains in the realtime feed. Check stop IDs.'
          : 'Both MTA feeds failed. Try again in a minute.',
        options: [],
        fetchedAt: new Date().toISOString(),
        degraded: true,
      }), { status: 502, headers });
    }

    const winner = options.reduce((a, b) => (a.totalMinutes <= b.totalMinutes ? a : b));
    const loser = options.find(o => o !== winner) || null;

    return new Response(JSON.stringify({
      recommendation: winner.label,
      reason: buildReason(winner, loser),
      options,
      fetchedAt: new Date().toISOString(),
      degraded: !irtOk || !nqrwOk,
    }), { headers });
  },
};
