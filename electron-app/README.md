# SLYA Electron wrapper

Local Electron wrapper for SLY Assistant.

Runtime files intentionally excluded from git:
- `data/`
- Electron/Chromium binaries (`electron.exe`, DLLs, pak files, etc.)
- backup files (`*.bak*`)
- logs

The updater is implemented in `main.js`.

## Automated travel diagnostics

The standalone app stores diagnostics in `data/automated-travel.sqlite` under each installation directory. It creates the database on the first diagnostic and writes from a background worker. Each row represents a forecast, selected movement, or fuel preflight. The full forecast inputs and per-leg timeline are retained in the JSON payload.

```sql
SELECT recorded_at, fleet, event_type, move_type, run_id,
       json_extract(payload, '$.decisionSource') AS decision_source
FROM automated_travel_diagnostics
WHERE instance_name = 'MUD'
  AND fleet IN ('CF-05|06', 'CF-05|Phantom')
ORDER BY recorded_at DESC
LIMIT 100;
```

Timestamps are UTC. Use `run_id` to link a forecast with its movement selection. The updater preserves the installation's `data/` directory across upgrades.

The wrapper uses Node's built-in SQLite driver when available. Older Electron installations use the vendored MIT-licensed [node-sqlite3-wasm 0.8.61](https://www.npmjs.com/package/node-sqlite3-wasm/v/0.8.61). Existing installations that receive the wrapper through the in-app updater fetch the pinned driver files the first time the older runtime needs them.
