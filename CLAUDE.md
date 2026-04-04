# CLAUDE.md – Ladefuchs Deploy-Regeln

## Bei jedem Git Push / Deploy

1. Versionsnummer in `index.html` hochzählen bei ALLEN Asset-Links:
   - `<script src="script.js?v=X.Y.Z"></script>`
   - `<link rel="stylesheet" href="styles.css?v=X.Y.Z">`
   - Patch-Version +1 bei Bugfixes (1.2.0 → 1.2.1)
   - Minor-Version +1 bei neuen Features (1.2.0 → 1.3.0)

2. Commit-Message soll die Version enthalten, z.B.:
   `fix: Ersparnis-Chip in History-Liste v1.3.1`

## Warum

Safari/iOS cached Assets sehr aggressiv. Ohne Versionsnummer
sehen Nutzer nach einem Deploy noch die alte Version.

---

## GitHub Action: go-e Auto-Import

**Dateien:** `.github/workflows/goe-import.yml`, `.github/scripts/goe-import.js`

**Trigger:** Alle 15 min (cron) + manuell (workflow_dispatch)

**API:** `https://{GOE_SERIAL}.api.v3.go-e.io/api/status`
Header: `Authorization: Bearer $GOE_TOKEN`

**Logik:**
1. `car === 4` + `wh > 10` → abgeschlossene Ladung
2. Duplikat-Check: selbes Datum + ±0.05 kWh in bestehenden Firestore-Charges
3. Kosten berechnen mit WIEN_TARIFFS (identisch zu script.js)
4. Speichern in `haushalte/haushalt` → `charges[]`, nach Datum sortiert

**Charge-Felder:**
- `dauer` = aktive Ladezeit aus `cdi` (ms → H:MM:SS)
- `dauerGesamt` = null (nicht über API verfügbar)
- `source` = `'go-e-auto'` (unterscheidet auto von CSV-Import)
- `maxKw` aus `nrg[11]` (W → kW)

**GitHub Secrets (Settings → Secrets → Actions):**
- `GOE_SERIAL` — 6-stellige Seriennummer
- `GOE_TOKEN` — Bearer Token aus go-e Cloud
- `FIREBASE_SERVICE_ACCOUNT` — vollständiger Service-Account-JSON
