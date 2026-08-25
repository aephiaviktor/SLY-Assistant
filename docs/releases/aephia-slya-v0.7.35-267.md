# Aephia SLYA 0.7.35-267 — Verified Accounting Evidence Boundary

## Outcome

This source release establishes a fail-closed producer boundary for Break-even accounting evidence.

Supported evidence is limited to explicitly annotated, confirmed operations carrying immutable transaction coordinates, exact quantities, operation identity, fleet identity, and source-specific lineage. Duplicate confirmed evidence remains idempotent and conflicting immutable identities remain rejected.

## Supported flows and coverage boundary

- Confirmed operation evidence retains transaction signature, instruction index, program, slot, block time, faction, profile, fleet, exact input/output quantities, lineage, and exact transaction fee lamports.
- Explicitly annotated operation wrappers may publish deterministic scanning, mining, crafting, or upgrading evidence through the existing durable outbox.
- Generic transaction-level token deltas are not authoritative operation evidence and are no longer published.
- Scanning and mining remain pending until their producers supply operation-bound asset, source/destination account, fleet, and location annotations.
- Crafting and upgrading remain pending until their producers supply operation identity and confirmed stage-signature annotations.
- Missing or ambiguous evidence never mutates authoritative inventory.

This is not complete global accounting coverage. Unsupported or unmatched flows remain pending or quarantined in the consumer.

## Immutable artifacts

- Product version: `0.7.35`
- Aephia version: `0.7.35-267`
- Canonical artifact: `SLY_Assistant.user.js`
- Canonical SHA-256: `12211bc1f13870993aa1d3771c00ba95da8fee2046c8f9eba9c0cc1e927473fa`
- Electron mirror: `electron-app/app/SLY_Assistant.user.js`
- Electron mirror SHA-256: `12211bc1f13870993aa1d3771c00ba95da8fee2046c8f9eba9c0cc1e927473fa`

## Publication boundary

Source publication only. No installation, deployment, restart, configuration change, or production write is included or authorized by this release.
