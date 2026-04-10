# CLAUDE.md – Wallbox Deploy-Regeln

## Bei jedem Git Push / Deploy

1. Versionsnummer in `index.html` hochzählen bei ALLEN Asset-Links:
   - `<script src="script.js?v=X.Y.Z"></script>`
   - `<link rel="stylesheet" href="styles.css?v=X.Y.Z">`
   - Patch-Version +1 bei Bugfixes (1.3.0 → 1.3.1)
   - Minor-Version +1 bei neuen Features (1.3.0 → 1.4.0)

2. Commit-Message soll die Version enthalten, z.B.:
   `feat: Benzin-Vergleich v1.4.0`

## Warum

Safari/iOS cached Assets sehr aggressiv. Ohne Versionsnummer
sehen Nutzer nach einem Deploy noch die alte Version.

---

## Aktuelle Version: 1.5.0

---

## GitHub Action: go-e Auto-Import

**Dateien:** `.github/workflows/goe-import.yml`, `.github/scripts/goe-import.js`

**Trigger:** Alle 15 min (cron) + manuell (workflow_dispatch)

**API:** `https://{GOE_SERIAL}.api.v3.go-e.io/api/status`
Header: `Authorization: Bearer $GOE_TOKEN`

**Erkennungslogik:**
- `car === 1` (idle/abgesteckt) + `wh > 10` + `lch` neu → neue Session
- Session-Zeitpunkt: `now - (rbt - lccfc)` → exakter Endzeitpunkt für SNAP
- Duplikat-Check: `lch` in bestehendem `charges[]` suchen (nicht lastProcessedSession)
- Gelöschte Einträge können re-importiert werden (lch fehlt → wird neu gespeichert)

**Kosten:**
- `energyPrice`, `gebrauchsabgabe`, `ust` aus Firestore `settings` (App-Einstellungen)
- Fallback auf WIEN_TARIFFS-Defaults falls Settings fehlen
- `snap` via `isSnap(date, time)` mit exaktem Session-Zeitpunkt

**Charge-Felder:**
- `lch` = Session-ID (Sekunden seit Reboot)
- `dauer` = aktive Ladezeit aus `cdi` (ms → H:MM:SS)
- `dauerGesamt` = null (nicht über API verfügbar)
- `source` = `'go-e-auto'`
- `maxKw` aus `nrg[11]` (W → kW)

**GitHub Secrets (Settings → Secrets → Actions):**
- `GOE_SERIAL` — 6-stellige Seriennummer
- `GOE_TOKEN` — Bearer Token aus go-e Cloud
- `FIREBASE_SERVICE_ACCOUNT` — vollständiger Service-Account-JSON

---

## Ersparnis-Vergleich (renderSavings)

Vier Karten im Dashboard:
1. **Tesla Supercharger** – kWh-Preis × Ladung
2. **Tanke Wien kWh** – kWh-Tarif × Ladung
3. **Tanke Wien Zeit** – min-Tarif × Ladezeit (nur wenn `c.dauer` vorhanden)
4. **Tiguan Benzin** – km-Schätzung via `comp_ev_verbrauch_kwh`, Benzinkosten via E-Control API

**E-Control API:** `fetchBenzinpreis()` lädt beim Start Median-Benzinpreis Wien (SUP, Wien Mitte).
Fallback auf `settings.comp_benzin_preis` falls API offline.

**Settings-Keys für Vergleich:**
- `comp_tesla_kwh`, `comp_tesla_abo_jahr`
- `comp_tanke_kwh`, `comp_tanke_zeit_min`, `comp_tanke_zeit_abo_monat`
- `comp_benzin_verbrauch_l`, `comp_ev_verbrauch_kwh`, `comp_benzin_preis`

Alle mit Defaults im settings-Merge-Block gesichert (NaN-safe).
