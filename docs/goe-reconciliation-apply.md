# go-e Reconciliation Apply

Der produktive Apply ist absichtlich zweistufig. Ein Voll-Apply darf niemals direkt auf Legacy-Matches schreiben.

## Phase 1: `identity-backfill`

Voraussetzungen:

1. manueller `go-e Reconciliation Dry Run` wurde geprüft,
2. `unmatchedSource = 0`, `unmatchedCharges = 0`, `sourceInconsistencies = 0`,
3. `projectedKwhTotal = sourceKwhTotal`,
4. vollständiger `planHash` ist freigegeben,
5. die zeilenweisen Legacy-Zuordnungen sind über `legacyApprovalRoot` eingefroren,
6. der Workflow erzeugt unmittelbar vor dem Write ein frisches verschlüsseltes Backup und lädt es erfolgreich hoch.

Phase 1 schreibt **nur**:

- `sessionKey`
- `goeSessionId`
- `identityBackfill` Audit-Metadaten

Sie verändert ausdrücklich **nicht**:

- `kwh`
- `total`
- `maxKw`
- Datum/Zeit
- SNAP/Tarifdaten
- Lade-/Steckdauer

Vor dem Write wird simuliert, dass danach kein Match mehr über `legacy` läuft.

## Pflichtschritt danach

Nach Phase 1 muss ein neuer `go-e Reconciliation Dry Run` ausgeführt und erneut geprüft werden.

Erwartung:

- `matchMethods.legacy = 0`
- alle Sessions matchen über `sessionKey` oder `goeSessionId`
- neuer `planHash`
- unverändert 0 unmatched / 0 Source-Inkonsistenzen

## Phase 2: `apply`

Der Voll-Apply bricht hart ab, sobald auch nur ein Match noch `legacy` verwendet.

Er schreibt den bereits in P1 geprüften Reconciliation-Plan auf das `charges`-Array. Dazu gehören insbesondere die historische kWh-Korrektur, daraus abgeleitete Kostenkorrekturen, data.v3-Sessionpeak und Metadaten-Backfills.

Zusätzliche Gates:

- freigegebener `planHash` entspricht exakt dem frisch erzeugten Pre-Write-Dry-Run,
- Firestore-Fingerprint ist vor dem Transaction-Write unverändert,
- go-e Source-Fingerprint wird unmittelbar vor dem Write erneut geprüft,
- Zielsumme entspricht exakt der data.v3-Session-Energiesumme,
- Pre-Write-Backup wurde vor dem Write erfolgreich als Action-Artefakt hochgeladen,
- der Write erfolgt in einer Firestore-Transaktion,
- anschließend wird der geschriebene Bestand per Fingerprint verifiziert.

## Manuelle Bestätigungen

Workflow `go-e Reconciliation Apply`:

### Identity Backfill

- `phase`: `identity-backfill`
- `approved_plan_hash`: vollständiger Hash aus geprüftem Dry-Run
- `approved_legacy_root`: vollständige `legacyApprovalRoot` aus geprüftem Dry-Run
- `confirm`: `BACKFILL_IDENTITIES`

### Final Apply

- zuerst neuen Dry-Run nach Phase 1 prüfen
- `phase`: `apply`
- `approved_plan_hash`: vollständiger neuer Hash
- `approved_legacy_root`: leer
- `confirm`: `APPLY_RECONCILIATION`

Die beiden Phasen sollen nicht in demselben Workflow-Lauf hintereinander ausgeführt werden. Zwischen ihnen ist der neue Dry-Run samt Review bewusst verpflichtend.
