# Aephia LP epoch data — 0.7.35-317

LP automation now reads epoch totals from the authenticated Aephia summary at
`https://store-sage-lp.aephia.workers.dev/summary`. The Ryden endpoint and its
points-category lookup have been removed from both runtime copies.

## Data contract

The adapter uses the v5 fields shown in the supplied API sample and the daily
final structures already supported by SLYA:

| Input | Epoch series behavior |
| --- | --- |
| `interval.factions.MUD`, `ONI`, `UST`/`USTUR`/`Ustur` | Maps LP instance IDs 1, 2 and 3 to their own faction. |
| `timestamp` or `dateTime` | Determines the UTC day and latest snapshot. Numeric timestamps accept seconds or milliseconds. |
| Decimal `dayIndex` | Day fallback when a snapshot has no usable timestamp. |
| Decimal `redeemedLp` | Nonnegative safe-integer LP total. Multiple snapshots in one day are cumulative: select the latest, never sum them. |
| `dailyFinalFromIntervals.factions` | Replaces interval totals for completed days, keyed by `date`. |
| `dailyFinal.factions` | Highest-priority completed-day totals, keyed by `date`. |

The current day always uses interval data. Future days are excluded. Missing
current-day data raises an explicit error instead of being treated as zero.
The existing requirement for seven completed days with positive LP remains.

### ATLAS reward pools

The operator confirmed these daily pools on 2026-11-14. All three are hardcoded
in `UPGRADE_AUTOMATION_ATLAS_POOL_OVERRIDES`, in whole ATLAS:

| Faction | ATLAS per day |
| --- | ---: |
| MUD | 1,991,250 |
| ONI | 2,000,000 |
| UST / USTUR | 2,000,000 |

Pricing history, strategy-profit calculations and Optimizer 2 use these
configured values. They take precedence over any optional token-pool field in
the summary. No faction needs a reward-pool field from Aephia or Ryden. LP
redemption totals for all three factions come from Aephia.

Faction settings spelled `USTUR` (including mixed case or surrounding spaces)
normalize to `UST`, rather than falling through to the MUD default.

These fixed rates also apply to historical pricing, matching the existing MUD
override behavior. If the daily pools change, update the constants and rerun
the tests before deploying a new version.

## Requests and errors

The existing configured Aephia API key is sent as a Bearer token. Concurrent
summary consumers share one download and the existing 30-second cache. Both
the native-fetch and userscript transports allow 60 seconds, including the
body download. No payload truncation or byte-size cap is added.

HTTP errors, invalid/truncated JSON, timeouts, missing faction data, invalid LP
values, and missing reward pools remain explicit errors. Failed requests can
be retried. A completed request for an old token does not overwrite the cache
after the configured token changes.

## Apply

Base: `aephiaviktor/SLY-Assistant`, branch `aep-release`, commit
`6caab0ddab44cbfa4f1ad13425806d81f5b4eb3c` (version 0.7.35-316).

This corrected patch supersedes the earlier 0.7.35-317 download, which did not
yet contain the confirmed ONI/UST pool values. Apply it to the original
0.7.35-316 base, not on top of the earlier patch.

Apply the supplied patch from the local repository root:

```powershell
git apply "$HOME\Downloads\SLY-Assistant-Aephia-v0.7.35-317.patch"
```

`git apply` checks the affected content and stops on conflicting changes; it
does not push or deploy. Review and commit the resulting changes, then use
your normal deployment process. Both the root userscript and the Electron
packaged userscript are included and byte-identical.

## Validation

```sh
node --check SLY_Assistant.user.js
node --check electron-app/app/SLY_Assistant.user.js
node --test test/*.test.js
node scripts/test-requested-lp-target.js
node scripts/test-lp-per-profile-history.js
node scripts/test-upgrading-optimization-telemetry.js
```

Results: 295 tests passed, including 19 new tests for cumulative snapshots,
daily-final precedence, UTC boundaries, all faction aliases, invalid/missing
values, LP control, pricing, telemetry, cache expiry, token changes, retry,
native/GM transports, a synthetic response over 4 MB, and faction changes that
share one download while keeping each faction's totals and pool separate. The three additional
regression scripts and syntax checks passed. Existing version-specific test
metadata was updated from 316 to 317.

No live authenticated API request or running-instance deployment was performed.
After deployment, confirm that the panel shows version 0.7.35-317, that each
faction's LP totals match Aephia, and that the execution plan is available. Unrelated
InfluxDB, forecast, inventory and resource-price dependencies still apply.
