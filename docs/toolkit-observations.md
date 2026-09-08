# Toolkit observations for MSA

SLYA collects finalized PHANTOM Toolkit clocks for MUD, ONI and USTUR regardless
of selected faction, fleet activity, or upgrade-automation state. MSA reads shared
Influx evidence; it need not run overnight. Existing charts are not adjusted.

Cadence: startup, first tick of each UTC hour, every 30 seconds from 23:55 through
00:10 UTC, and after a timer delay over 90 seconds or backward clock jump. Pending
uploads retry every five minutes without RPC. Stop scheduling on page unload.
Network work is serialized; request latency can delay sampling.

A bounded adapter over SLYA’s configured read providers supplies Game, GameState, Starbase and chain
Clock at one finalized slot. The minimal IDL is taken from MSA v0.6.292; cached
inventory values are not used. One instance covers all three factions. Extra
instances can increase RPC traffic, but identical observation IDs and non-overlap
calculations in MSA prevent double-counting downtime.

Uses the existing Influx URL/auth/bucket settings, accepting configured v2/v3 write
endpoints with nanosecond precision. That destination must match MSA's primary
bucket and organization. Raw `starbase_toolkit_clock_v1` records and identity hashes
are compatible with MSA v0.6.292. No secrets enter journal keys, records or statuses.

Destination-scoped GM journals retain 35 days, are saved before HTTP, and acknowledge
only successful writes. Failed or ambiguous writes retry identical points; 128
points/batch, at most 512/faction/pass, 15-second HTTP timeout. A failure in one
faction does not stop the others. Changing destination isolates its pending queue;
changing only authentication does not. Storage failures leave uploads unacknowledged.
`window.slyaToolkitClockStatus` exposes bounded per-faction status for diagnosis.

`lib/toolkit-collector.js` and `lib/toolkit-upkeep-idl.json` are embedded in both
userscript distributions via `python3 scripts/embed-toolkit-collector.py`, so normal
userscript updates deliver the feature without a wrapper update. The collector uses
GM storage in both browser and standalone; the standalone implementation uses its
persistent localStorage. Existing unsynced MSA data is not copied automatically:
MSA still reads that local evidence without uploading it.

Validation uses real public account fixtures, the shipped browser decoder, offline
restart/retry tests and reader compatibility. No live overnight validation performed.

Toolkit RPC uses at most two configured read providers per request, with automatic
429 retries disabled and a 15-second deadline per HTTP response (including body).
It does not enter the automation proxy’s indefinitely retrying fallback loop.
