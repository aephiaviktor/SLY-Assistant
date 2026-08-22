# SLYA-I1A authoritative inventory snapshot foundation

Source-only; no production import, call site, timer, menu, write, or automatic execution.

## RPC consistency gate

For each complete profile-owned cargo-pod location, explicitly invoke `getParsedTokenAccountsByOwner(cargoPod, { programId: TOKEN_PROGRAM_ID }, 'finalized')` through the existing shared RPC limiter. Every `RpcResponseAndContext.context.slot` must be present and exactly identical. Timing, batching, `minContextSlot`, and similar block times are not evidence. Fetch blockhash and block time for that exact finalized slot; both must bind to the same slot.

Retry the whole capture at most twice after the first attempt (3 attempts total). A capture with `L` locations costs `L + 2` calls per attempt (L token enumerations, block evidence, block time), maximum `3 × (L + 2)`. Every call remains limiter-governed. Any exhausted mismatch/failure returns unavailable and publishes nothing.

## Manifest and exact quantities

Inputs are exact faction, full player public key, authoritative complete cargo-pod/location list, and complete recognized mint/asset/decimals list. Their Cartesian product is the expected identity manifest. Each response must exist; unknown mint, duplicate account, malformed account, decimals mismatch, or partial enumeration invalidates the whole snapshot. Missing token account within a successfully enumerated pod is explicit zero.

Use `tokenAmount.amount` only (canonical integer string) plus integer mint decimals. `uiAmount`, `Number`, `parseFloat`, and `parseInt` are forbidden for quantities. Decimal text is derived by string arithmetic, preserving tiny and arbitrarily large amounts.

## Envelope schema v1

`schemaVersion`, faction, player public key, finalized context-slot string, blockhash, snapshot UTC time, creation time, expected identity count, sorted rows, rows hash, immutable snapshot ID, and `snapshotComplete: true`. Rows contain location, cargo pod, asset, mint, raw amount string, mint decimals, and exact decimal quantity.

Rows hash covers deterministic sorted rows. Snapshot ID covers the immutable envelope excluding creation time and itself. Same inputs replay identically regardless of input order/time; a corrected balance changes rows hash and snapshot ID.

## Influx format (designed, not invoked)

One `inventory_snapshot_row` record per row followed by exactly one `inventory_snapshot_manifest` record. The manifest is last and binds snapshot ID, rows hash, expected/published counts, faction/profile, slot, snapshot time, schema and completion. Raw amount, quantity, context slot, hashes and timestamp are string fields where precision matters. A consumer rejects missing/non-final manifests. Identical replay has identical logical snapshot ID and lines.

## Preconditions before controlled publication

- Establish the authoritative complete location list from profile/starbase-player state at the same finalized context.
- Establish the complete recognized mint/decimals registry and bind its revision/hash.
- Implement the explicitly invoked RPC orchestration through the existing limiter and prove exact-slot retries on the configured provider.
- Decide durable correction/supersession publication semantics and consumer validation.
- Keep existing opportunistic `starbase.curAmount` unchanged until migration is separately authorized.
