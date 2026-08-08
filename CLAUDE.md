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

## Aktuelle Version: 1.10.3

---

## GitHub Action: go-e Auto-Import

**Dateien:** `.github/workflows/goe-import.yml`, `.github/scripts/goe-import.js`

**Trigger:** Alle 15 min (cron) + manuell (workflow_dispatch)

**API:** `https://{GOE_SERIAL}.api.v3.go-e.io/api/status`
Header: `Authorization: Bearer $GOE_TOKEN`

**Erkennungslogik:**
- `car === 1` (idle/abgesteckt) + `wh > 10` + `lch` neu → neue Session
- Session-Zeitpunkt: `now - (rbt - lccfc)` → exakter Endzeitpunkt für SNAP
- Duplikat-Check 1: `lch` in bestehendem `charges[]` suchen (nicht lastProcessedSession)
- Duplikat-Check 2 (`date`+`kwh`): greift **nur gegen Einträge ohne `lch`** (CSV/manuell).
  Sonst würde eine echte zweite Session am selben Tag mit ähnlicher kWh-Menge nie importiert.
  Zeitvergleich geht nicht: CSV speichert den Steckbeginn, der Auto-Import den Ladeschluss.
- Gelöschte Einträge können re-importiert werden (lch fehlt → wird neu gespeichert)

**Dedup in der App (`deduplicateCharges`):** Key ist `date` + `time` + `kwh` (0,1er-Raster),
parallel dazu `lch`. Die Uhrzeit gehört zwingend in den Key – ohne sie löscht `loadFromCloud()`
bei jedem Start eine zweite echte Ladung desselben Tages und schreibt das in die Cloud zurück.

**Kosten:**
- `energyPrice`, `gebrauchsabgabe`, `ust` aus Firestore `settings` (App-Einstellungen)
- Fallback auf WIEN_TARIFFS-Defaults falls Settings fehlen
- `snap` via `isSnap(date, time)` mit exaktem Session-Zeitpunkt

**Charge-Felder:**
- `lch` = Session-ID (Sekunden seit Reboot)
- `dauer` = aktive Ladezeit aus `cdi` (ms → H:MM:SS)
- `dauerGesamt` = null (nicht über API verfügbar)
- `source` = `'go-e-auto'`
- `maxKw` aus dem **Peak-Tracker**, nicht aus `nrg[11]` zum Importzeitpunkt

**Peak-Tracker (`maxKw`):** `nrg[11]` ist die *momentane* Leistung. Der Import läuft aber
erst bei `car === 1` (abgesteckt) – dort fliesst nichts mehr und der Wert ist immer 0.
Deshalb wird bei `car === 2` (lädt) jeder Lauf `nrg[11]` mitgeschrieben und das Maximum
gehalten; beim Import wird es via `consumePeak()` übernommen und der Tracker geleert.

- State liegt in **eigenem Dokument** `haushalte/goe-peak-tracker`. Nicht als Feld in
  `haushalte/haushalt`: `syncToCloud()` schreibt mit `.set()` **ohne** `{merge:true}` und
  würde jedes der App unbekannte Feld beim nächsten Nutzer-Sync löschen.
- Session-Reset erkannt über `wh` (fällt = neue Session) und `rbt` (fällt = Reboot).
- `consumePeak()` läuft **vor** allen Abbruchpfaden (`wh < 10`, Duplikat-Checks), damit ein
  Peak nicht in die nächste Session überläuft.
- Ohne Tracking-Daten bleibt `maxKw` **`null`** – kein Fallback auf `nrg[11]`, denn 0 ist
  kein Maximum. Die 15 Einträge vor v1.10.3 haben deshalb `maxKw: 0` (nicht rückwirkend
  reparierbar, die API liefert keine Historie).
- Es ist ein **abgetastetes** Maximum (15-min-Raster): eine kurze Spitze zwischen zwei
  Läufen wird nicht gesehen. Für „hängt die Wallbox dauerhaft nahe 11 kW?" reicht das,
  weil die Ladeleistung über weite Teile der Session konstant ist.
- Relevanz: ab 1.1.2027 bestimmt das höchste 15-min-Mittel des Monats den Leistungspreis
  auf Netzebene 7 (SNE-G-V). `maxKw` ist die Datenbasis dafür.

**GitHub Secrets (Settings → Secrets → Actions):**
- `GOE_SERIAL` — 6-stellige Seriennummer
- `GOE_TOKEN` — Bearer Token aus go-e Cloud
- `FIREBASE_SERVICE_ACCOUNT` — vollständiger Service-Account-JSON

---

## Tarif-Historie (datumsabhängiger Energiepreis)

- `settings.tariffHistory`: `[{ from:'YYYY-MM-DD'|'', energy:Number, label:String }]`
  (`from` leer = „ab Beginn"). Nur der Energie-Arbeitspreis variiert pro Anbieter –
  Netzentgelte/Abgaben sind immer Wiener Netze.
- `energyPriceFor(date)` → Preis der jüngsten Periode mit `from <= date`, sonst `settings.defaultEnergy`.
- Neue Ladungen (manuell, CSV, go-e-CSV/JSON-Import) ziehen den datums-passenden Preis.
- `migrateTariffPrices()` läuft beim Start (nach `migrateSnapTiming`) und gleicht
  `energyPrice`/`total`/`bruttoPerKwh` bestehender Ladungen an die Historie an.
- `priceManual: true` (manuell gesetzter Preis via Edit/expliziter Import) → von der Migration ausgenommen.
  Wird beim Import am **geparsten Wert** festgemacht, nicht an der Existenz der Spalte/des Feldes –
  sonst nimmt Müll in Spalte 3 den Eintrag dauerhaft aus der Migration.
- Der Ersparnis-Chip in Liste und „Letzte Ladung" (`calcSavingChip(c)`) rechnet die Wallbox-Seite
  aus dem gespeicherten `c.total` – also mit Tarif und SNAP-Status **dieser** Ladung, nicht mit
  `settings.defaultEnergy`. Die Vergleichstarife (Tesla/Tanke) haben bewusst keine Historie.
- `settings.defaultEnergy` bleibt aktueller Preis/Fallback (go-e-Auto-Import liest ihn aus Firestore – immer „jetzt").
- Editor in den Einstellungen: `renderTariffHistory` / `readTariffRows` / `addTariffRow` / `removeTariffRow`.

## Ersparnis-Vergleich (renderSavings)

Vier Karten im Dashboard:
1. **Tesla Supercharger** – kWh-Preis × Ladung
2. **Tanke Wien kWh** – kWh-Tarif × Ladung
3. **Tanke Wien Zeit** – min-Tarif × Ladezeit (nur wenn `c.dauer` vorhanden)
4. **Tiguan Benzin** – km-Schätzung via `comp_ev_verbrauch_kwh`, Benzinkosten via E-Control API

**E-Control API:** `fetchBenzinpreis()` lädt beim Start den Median-Benzinpreis Wien
(SUP, `by-address` um Wien Mitte, `includeClosed=true` → Stichprobe unabhängig von der Uhrzeit).
Die API liefert nur die *günstigsten* Tankstellen der Umgebung – der Wert ist also
bewusst ein Median der günstigsten Stationen, kein Wien-Durchschnitt.

- Live-Wert liegt in `benzinPreisLive` (Modul-Variable), **nicht** in `settings` –
  sonst würde er über `persist()`/`syncToCloud()` den manuellen Fallback dauerhaft
  überschreiben und mit dem asynchronen `loadFromCloud()` um die Reihenfolge rennen.
- `benzinPreis()` → Live-Wert, sonst `settings.comp_benzin_preis` (Fallback aus Einstellungen).
  Wird von `renderSavings`, `renderAmortisation` und der Detailansicht verwendet.
- `benzinPreisLabel()` → Badge-Text inkl. Quelle: live (mit Anzahl Tankstellen + Uhrzeit),
  `pending` oder `fallback` (API nicht erreichbar).

**Settings-Keys für Vergleich:**
- `comp_tesla_kwh`, `comp_tesla_abo_jahr`
- `comp_tanke_kwh`, `comp_tanke_zeit_min`, `comp_tanke_zeit_abo_monat`
- `comp_benzin_verbrauch_l`, `comp_ev_verbrauch_kwh`, `comp_benzin_preis`

Alle mit Defaults im settings-Merge-Block gesichert (NaN-safe).
