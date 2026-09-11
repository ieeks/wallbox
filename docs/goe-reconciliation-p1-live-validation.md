# P1 Live-Dry-Run Validation — 2026-09-11

The read-only branch validation ran against the current Firestore household and the live go-e data.v3 direct export.

Aggregate result only (no private charging history is committed here):

- source sessions: 23
- current charges: 23
- matched: 23
- unmatched source sessions: 0
- unmatched current charges: 0
- proposed energy corrections (> 0.02 kWh): 19
- mismatches > 1 kWh: 1
- records receiving metadata backfill: 23
- source energy/meter inconsistencies: 0
- automated tests: 165 / 165 green
- read-only validation: successful
- encrypted backup + encrypted detailed plan artifact: successfully created and uploaded
- Firestore writes/deletes during validation: none

The detailed plan and backup were intentionally kept out of the public repository and public log output.
