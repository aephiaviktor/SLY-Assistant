# SLYA Electron wrapper

Local Electron wrapper for SLY Assistant.

Runtime files intentionally excluded from git:
- `data/`
- Electron/Chromium binaries (`electron.exe`, DLLs, pak files, etc.)
- backup files (`*.bak*`)
- logs

The updater is implemented in `main.js`.

## Automated travel diagnostics

The standalone app stores diagnostics in `data/automated-travel.sqlite` under each installation directory. A background worker creates the database on the first diagnostic and writes each forecast, selected movement, or fuel preflight. The `payload` column contains queryable JSON with the decision, shortfall, and forecast summary. `forecast_gzip` contains the complete forecast as gzip-compressed JSON, including its inputs, per-leg timeline, and Warp replays.

```sql
SELECT recorded_at, fleet, event_type, move_type, run_id,
       json_extract(payload, '$.decisionSource') AS decision_source
FROM automated_travel_diagnostics
WHERE instance_name = 'MUD'
  AND fleet IN ('CF-05|06', 'CF-05|Phantom')
ORDER BY recorded_at DESC
LIMIT 100;
```

Timestamps are UTC. Use `run_id` to link a forecast with its movement selection. To read the full forecast from a row, select both `payload` and `forecast_gzip` and decode them as follows. The same reader works with copies of the older database after selecting `NULL AS forecast_gzip` in place of the new column.

```python
import gzip
import json

record = json.loads(payload)
if forecast_gzip is not None:
    record["forecast"] = json.loads(gzip.decompress(forecast_gzip))
```

The updater preserves the installation's `data/` directory. The first diagnostic after upgrading compresses existing full forecasts and reclaims their disk space. Each installation keeps up to 32 MiB of diagnostics. When the database exceeds that limit, it removes the oldest records and compacts the file to about 24 MiB or less. A temporary reader lock can defer compaction to a later write.

The wrapper uses Node's built-in SQLite driver when available. Older Electron installations use the vendored MIT-licensed [node-sqlite3-wasm 0.8.61](https://www.npmjs.com/package/node-sqlite3-wasm/v/0.8.61). Existing installations that receive the wrapper through the in-app updater fetch the pinned driver files the first time the older runtime needs them.
