# P1 Live-Dry-Run Validation — 2026-09-11

The read-only branch validation ran against the current Firestore household and the live go-e data.v3 direct export.

Aggregate result only (no private charging history is committed here):

- source sessions: 23
- current charges: 23
- matched: 23
- unmatched source sessions: 0
- unmatched current charges: 0
- proposed energy corrections: 21
- mismatches > 1 kWh: 1
- records receiving metadata reconciliation/backfill: 23
- source energy/meter inconsistencies: 0
- current total: 1197.352 kWh
- authoritative data.v3 `Energie [kWh]` total: 1174.499 kWh
- rounded start/end meter-span total: 1174.498 kWh
- projected reconciled total: 1174.499 kWh
- automated tests: 167 / 167 green
- read-only validation: successful
- Firestore writes/deletes during validation: none

The 0.001 kWh difference between exported session energy and the sum of the separately rounded cumulative meter readings occurs in exactly one session and remains within the source-consistency guard. `Energie [kWh]` is therefore used as the historical reconciliation target; meter readings remain the identity and plausibility source.

Historical `maxKw` is also reconciled from the completed data.v3 session export rather than preserving a possibly undersampled 15-minute live peak.

Encrypted backup artifacts use a dedicated `RECON_BACKUP_KEY` secret and are no longer cryptographically coupled to the Firebase service-account credential. Before the production dry-run workflow is used, that repository secret must contain at least 32 random bytes encoded as Base64.

The detailed plan and backup remain intentionally outside the public repository and public log output.
