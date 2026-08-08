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

## Aktuelle Version: 1.13.0

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

## go-e CSV-Import (`processFile`, ab v1.11.0)

**Zwei Export-Varianten, beide müssen laufen:**

| | App-Export (`EnergieReport.csv`) | data.v3.go-e.io |
|---|---|---|
| Trennzeichen | Komma | Semikolon |
| Quoting | nur mehrzeiliges Header-Feld | **jedes** Feld |
| Dezimaltrenner | Punkt | Komma |
| Leistung | `Maximale Leistung` | `max. Leistung [kW]` |
| Dauer | `Gesamtzeit` / `Ladezeit` | `Dauer gesamt` / `Dauer aktiver Stromfluss` |
| Dauer-Format | `17H 43min 18S`, `1T 9H 59min 49S` | `HH:MM:SS` (auch `33:59:49`) |

Ein zeilenweises `split('\n')` reicht für **keine** der beiden: beim App-Export
zerreisst es den Header (das Feld `"Zähler\ndifferenz"` enthält ein Newline), bei
data.v3 bleiben die Quotes an Werten (`parseFloat('"72.324"')` → NaN) und an
Spaltennamen (`'"start"' !== 'start'`). Deshalb `parseCsv()` als echter Tokenizer
+ `detectDelim()` (das Zeichen, das in der Kopfzeile die meisten Felder ergibt).

- `normDauer()` normalisiert beide Dauer-Formate auf `H:MM:SS` (Eingabe für `dauerToMs`).
- `parseNum()`: Dezimalkomma **oder** -punkt, nie beides in derselben Datei.
- Spaltensuche über `findCol()` mit Alias-Liste. `energie pv`/`energie akku` sind
  explizit ausgeschlossen, sonst kapern sie die Energiespalte.
- `isGoE` ergibt sich daraus, ob `start` **und** die Energiespalte gefunden wurden –
  nicht mehr aus einem Header-Substring. Abgebrochen wird nur bei eindeutigen
  go-e-Merkmalen, damit generische CSVs mit einer Spalte `energie` weiter durchlaufen.

**Backfill statt Überspringen:** Erkannte Duplikate werden nicht mehr verworfen,
sondern ergänzen fehlende Felder (`maxKw`, `dauerGesamt`, `dauer`) am bestehenden
Eintrag. Bestehende Werte werden **nie** überschrieben; `kwh`, `total`,
`energyPrice`, `snap`, `lch`, `date`, `time` bleiben unangetastet. Landet in
`importBackfill[]`, wird in der Vorschau separat angezeigt und erst in
`confirmImport()` per `Object.assign` angewandt.

**`matchExistingCharge(kwh, endeMs)`** – die Zuordnung ist der heikle Teil:
- Die Uhrzeit taugt **nicht** als Schlüssel: CSV = Steckbeginn, Auto-Import = Ladeschluss.
- Das Datum auch nicht: mehr als die Hälfte der Sessions endet an einem anderen
  Kalendertag, als sie beginnt. Der frühere `c.date === date`-Check legt deshalb
  Duplikate an, statt die Zeile als bekannt zu erkennen.
- Schlüssel ist `kwh` (±0,01). Bei mehreren Kandidaten (`77,089` vs `77,086`
  liegen 0,003 auseinander) entscheidet die Nähe zum Ladeende – aber nur, wenn
  der Zweitbeste > 24 h entfernt ist, sonst kein Match.
- Der beste Kandidat muss innerhalb von 48 h zum CSV-Ende liegen, sonst gilt die
  Zeile als echte neue Ladung (gleiche kWh-Menge Monate später).

---

## Monatsverlauf – aufklappbare Monate (`renderMonthStats`, ab v1.12.0)

Klick auf eine Monatszeile blendet die Einzelladungen darunter ein (Datum · Uhrzeit,
kWh, `maxKw`, Kosten) plus eine Fusszeile mit der höchsten Ladeleistung des Monats.

- Zustand in der Modul-Variable `expandedMonths` (Set von `'YYYY-MM'`), damit ein
  Neu-Rendern durch `persist()`/`refreshDashboard()` die offenen Monate nicht zuklappt.
  Bewusst **nicht** in `settings` – das würde über `syncToCloud()` in der Cloud landen.
- Mehrere Monate gleichzeitig offen sind erlaubt.
- `toggleMonthDetail(key)` ruft `renderMonthStats()` direkt auf, nicht `refreshDashboard()` –
  der Rest des Dashboards ändert sich beim Aufklappen nicht.
- Der Monats-Peak ist das Maximum über `c.maxKw > 0`; Einträge ohne Wert zeigen `—`
  und werden nicht als 0 gewertet.
- Die Zeile ist per `role="button"` + `tabindex` + Enter/Space auch ohne Maus bedienbar.

---

## Monats-Peak-Diagramm (`renderPeakChart`, ab v1.13.0)

Ersetzt das frühere Linien-Chart „Kosten / Tag" (`renderChart`). Das war aus drei
Gründen nicht zu retten:
1. Die X-Achse war der **Index** des Punkts (`x = i/(n-1)`), keine Zeitachse.
   Ladeabstände von 1 bis 16 Tagen wurden gleich breit gezeichnet.
2. „Kosten pro Ladetag" misst faktisch, wie leer der Akku war – kein Trend, den
   man beeinflussen könnte.
3. Das Label sagte „Kosten / Tag", der Badge daneben zeigte die **Summe**.

Stattdessen: Balken je Monat mit dem höchsten `maxKw`, dazu eine gestrichelte
Linie bei `PEAK_THRESHOLD_KW = 10` (Staffelgrenze der SNE-G-V auf Netzebene 7).
Balken darüber rot, darunter grün. Badge zählt die Monate über der Schwelle.

- Monate ohne jeden `maxKw`-Wert zeigen `—` und einen Stummel-Balken – **nicht** 0.
  Ein Peak von 0 wäre eine Falschaussage, kein fehlender Wert.
- Monate mit teilweise fehlenden Werten bekommen ein `*` am Wert plus Fussnote.
- Skala geht immer bis mindestens 11 kW, damit die 10-kW-Linie nicht am Rand klebt.
- Die Schwellenlinie endet 34 px vor dem rechten Rand; dort sitzt ihre Beschriftung,
  sonst streicht die Linie durch den Text. Linie liegt per `z-index` **über** den
  Balken – nur so ist „drüber oder drunter" sofort ablesbar.
- Farbtoken `--red` / `--red-dim` wurden dafür in beide Themes ergänzt (gab es vorher nicht).

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
