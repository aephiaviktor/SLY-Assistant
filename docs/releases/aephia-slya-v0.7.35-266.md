# Aephia SLYA 0.7.35-266 — LP Automation Claim Reliability

## Outcome

This release candidate combines the unchanged implementation commits:

- `d4e2bc4bcbdc053495991fe2d723ec462d12a614` — upgrade claim-attempt telemetry ledger (P1A)
- `e14149fe96e0a84ec723020814b70fbb37edf88e` — idempotent upgrade claim recovery (P1B)

It makes upgrade completion attempts joinable and restart-safe, coalesces concurrent triggers, verifies ambiguous transactions before retry, prevents pending-signature resends, isolates faction/instance identities, and finalizes completion telemetry idempotently.

## Compatibility and boundaries

- No optimizer-policy or component-selection change.
- No new timer, polling loop, recurring fetch path, or uncontrolled retry cadence.
- Bounded signature/crafting-state verification occurs only inside an existing claim opportunity and gates or replaces a resend.
- Existing upgrading and optimizer field names, types, units, and invariants are unchanged.
- Telemetry/outbox failures remain isolated from claim execution.

## Immutable artifacts

- Version: `0.7.35-266`
- Canonical artifact: `SLY_Assistant.user.js`
- Canonical SHA-256: `2fcf3e1840b6166b969c7a845b18effcbe1ccf446dd3cd2d2ae7bbaa09ce4372`
- Electron mirror: `electron-app/app/SLY_Assistant.user.js`
- Electron mirror SHA-256: `2fcf3e1840b6166b969c7a845b18effcbe1ccf446dd3cd2d2ae7bbaa09ce4372`

## Verified rollback source

- Rollback commit: `c1733197e39914ace0994dc953ac9211354bae72`
- Rollback version: `0.7.35-265`
- Rollback canonical artifact SHA-256: `c72abbe57c8abaa36ee1cb314a052addce82e469fc4a5a8ef782a58efba19798`

## Rollout contract (pending authorization)

- Application: SLYA only.
- Repository: this SLY-Assistant repository and the immutable release artifact above.
- Intended active upgrading instances: establish from fresh runtime baseline before deployment; deploy sequentially and never simultaneously with an MSA live action.
- Protected state: all settings, identities, fleet accounts, assignments, enabled states, routes, scanner configuration, optimizer configuration, and Influx configuration.
- Out of scope: MSA, unrelated repositories/processes, optimizer policy, component selection, and production configuration changes.
- Required runtime evidence: process and full fleet-configuration integrity before/after, claim identity linkage, no duplicate sends/finalization, no pending-signature resend, restart-safe state, distinct faction/instance identities, stable scheduler/RPC/CPU behavior, compatible upgrading invariants, and one natural claim cycle per active upgrading instance or `NOT OBSERVED` after the agreed window.
- Publication/deployment, restart, production writes, and canary remain unauthorized until the combined gate is approved.
