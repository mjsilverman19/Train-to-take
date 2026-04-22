# train-to-take

A tiny Cloudflare Worker that answers one question every weekday morning: should I take the **6** from 86 St (Lex) or walk to 86 St (2 Av) and ride the **Q → R/W** transfer to get from 314 E 82nd St to 245 5th Ave? It fetches the MTA's GTFS-Realtime feeds, adds up walks + waits + rides for both routes, and tells me which one gets me to work sooner.

## Deploy

Cloudflare's GitHub integration is already wired up, so:

```
git push origin main
```

...and Cloudflare builds + deploys. The live URL should be `https://train-to-take.<your-subdomain>.workers.dev/`.

## Try it

```
curl https://train-to-take.<your-subdomain>.workers.dev/
```

Response shape:

```json
{
  "recommendation": "6",
  "reason": "6 in 3 min beats Q+R/W (next Q in 1 min, 9 min wait at Herald)",
  "options": [
    { "label": "6", "totalMinutes": 26, "nextTrainMinutes": 3, "breakdown": { ... } },
    { "label": "Q+R/W", "totalMinutes": 29, "nextTrainMinutes": 1, "breakdown": { ... } }
  ],
  "fetchedAt": "2026-04-22T12:34:56.000Z",
  "degraded": false
}
```

## iOS Shortcut

1. **Get Contents of URL** → `https://train-to-take.<your-subdomain>.workers.dev/`
2. **Get Dictionary Value** → key `recommendation` (save as "Rec")
3. **Get Dictionary Value** (on the same URL result) → key `reason` (save as "Why")
4. **Show Notification** → `Take the [Rec]. [Why]`

Pin it to the Home Screen or run it from the Lock Screen widget on your way out the door.

## Tuning

All commute-specific knobs live in the `CONFIG` block at the top of `src/index.js`. No TypeScript, no build step in your head — just open it on your phone, tweak a number, push.

## Things to verify

- [ ] **Stop IDs.** The placeholders `626S`, `Q05S`, `R20S` are best guesses. Confirm against MTA's [stops.txt](http://web.mta.info/developers/data/nyct/subway/google_transit.zip). `R20S` in particular may need to be `R17S` for 34 St-Herald Sq — if Option B always shows no trains, flip it.
- [ ] **Feed URLs.** The NYCT endpoints at `api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2F...` were unauthenticated as of 2024. Re-check at https://api.mta.info/#/subwayRealTimeFeeds if the worker starts returning `degraded: true`.
- [ ] **Ride-time constants.** `RIDE_6_86_TO_28`, `RIDE_Q_86_TO_HERALD`, `RIDE_RW_HERALD_TO_28` are rough. After a week of real trips, replace with your actual averages.
- [ ] **Walk times.** `WALK_TO_LEX_86` and friends are door-to-turnstile-to-door. Tune after a few runs.
