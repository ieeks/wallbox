# go-e Reconciliation P1

P1 is deliberately split into **planning** and a later, separately approved **apply** step.

## This branch does

- downloads the precise `data.v3.go-e.io` session export via the charger's `dll` token and `/api/v1/direct_export`
- reads `haushalte/haushalt`, `haushalte/charge-deletions`, `haushalte/goe-import-state`, `haushalte/goe-peak-tracker` and `haushalte/haushalt/trips`
- creates a one-to-one reconciliation plan between current charges and go-e sessions
- proposes energy corrections only when the data.v3 energy column and the meter span are mutually consistent
- does **not** create unmatched source sessions
- does **not** write to or delete from Firestore
- creates an AES-256-GCM encrypted Firestore backup and encrypted detailed reconciliation plan
- prints only aggregate counts to Actions logs

## Safety gates for a future apply step

A later apply implementation must remain a separate change and may only proceed when:

1. `unmatchedSource === 0`
2. `unmatchedCharges === 0`
3. `sourceInconsistencies === 0`
4. the current charges fingerprint still matches the dry-run fingerprint
5. the source export fingerprint still matches the approved dry-run
6. the approved `planHash` matches exactly
7. a fresh encrypted backup has been created successfully

The apply step must update existing charge records only. It must never silently create or delete charging sessions.

## Historical-data policy

- data.v3 meter delta (`Zaehlerstand Ende - Zaehlerstand Anfang`) is the authoritative historical energy quantity
- differences up to and including `0.02 kWh` remain untouched to avoid churn from harmless historical rounding
- larger, source-consistent differences are proposed for correction
- historical unit pricing is preserved; totals are recalculated from the stored `bruttoPerKwh` (or, if unavailable, the existing total/kWh ratio)
- every applied change must retain reconciliation audit metadata
