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

## Aktuelle Version: 1.16.0

---

## GitHub Action: go-e Auto-Import

**Dateien:** `.github/workflows/goe-import.yml`, `.github/scripts/goe-import.js`

**Trigger:** Alle 15 min (cron) + manuell (workflow_dispatch)

**API:** `https://{GOE_SERIAL}.api.v3.go-e.io/api/status`
Header: `Authorization: Bearer $GOE_TOKEN`

**Fehlerbehandlung (`fetchStatus`):** Die Cloud kennt drei Antworten – `200` (Daten da),
`403` (Charger offline **oder** Cloud-API nicht aktiviert) und `404` (Auth ok, Charger
sendet gerade nichts). 403/404 sind Betriebszustände, keine Defekte, und beenden den Lauf
**grün** – sonst steht die Action bei jedem WLAN-Aussetzer auf Fehler und ein echter
Defekt fällt nicht mehr auf. Sichtbar bleiben sie über eine `::warning::`-Annotation,
denn 403 heisst eben auch „Cloud-API in der App abgedreht" – ein Zustand, der von allein
nie wieder weggeht. 5xx und Netzwerkfehler werden 3× mit 5s/10s-Backoff wiederholt und
erst dann rot. Kein Datenverlust dabei: die Session steht bis zur nächsten in `wh`/`lch`,
und der Zeitstempel aus `now - (rbt - lccfc)` stimmt auch Stunden später noch. Was fehlt,
ist der Peak – `nrg[11]` wird nur bei `car === 2` abgetastet.

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

## Aufklappbare Dashboard-Sektionen (`sectionShell`, ab v1.15.0)

„Ersparnis vs. Alternativen", „Amortisation Wallbox", „Monatsverlauf", „Geladene
Energie / Monat" und „Höchste Ladeleistung / Monat" lassen sich über die Überschrift
zu- und aufklappen.

- Zustand in `collapsedSections` (Set von IDs), persistiert in **localStorage**
  (`lf_collapsed`) – bewusst weder in `settings` (sonst landet reine Ansicht über
  `syncToCloud()` in der Cloud und am Handy klappt zu, was am Desktop zugeklappt wurde)
  noch nur im Speicher wie `expandedMonths` (ein Reload soll den Zustand behalten).
- `sectionShell(id, title, body)` baut Kopf + `.cs-body`; die vier JS-gerenderten
  Sektionen nutzen sie. Die Peak-Sektion steht fest in `index.html` und bekommt ihren
  Zustand beim Start über `applyCollapsedState()`.
- `toggleSection()` schaltet nur die Klasse `is-collapsed` am Wrapper um, ohne
  Neu-Rendern – die Sektionen kommen aus verschiedenen `render*`-Funktionen.
- Titel sind `role="button"` + `tabindex` + Enter/Space, analog zu den Monatszeilen.
- Die Sektionstitel der JS-Sektionen liegen jetzt **in** der jeweiligen
  `render*`-Funktion (vorher stand „Ersparnis vs. Alternativen" statisch im HTML) –
  sonst bliebe beim Zuklappen die Überschrift doppelt stehen.

---

## kWh-je-Monat-Diagramm (`renderKwhChart`, ab v1.15.0)

Balken je Monat mit der geladenen Energie, nur in Jahres- und Gesamt-Übersicht
(im Monatsmodus gäbe es genau einen Balken). Badge: Summe, Untertitel: Ø kWh/Monat.

- Die Zeitachse wird über `monthKeysBetween()` **lückenlos** aufgefüllt. Anders als
  beim Peak-Diagramm ist ein Monat ohne Ladung hier eine echte 0 (kein fehlender
  Messwert) und bekommt einen Stummel-Balken – sonst rücken zwei Monate nebeneinander,
  zwischen denen ein halbes Jahr liegt.
- Bis 12 Balken stehen die Werte über den Säulen, darüber (`dense`) nur noch jedes
  dritte Monatslabel plus Jahreswechsel (`Jän 26`); Werte dann per `title`-Tooltip.
  Neben einem Jahres-Label entfällt das Raster-Label, sonst überlappen beide.
- `KWH_CHART_MAX_MONTHS = 24` begrenzt die Historie, danach Fussnote – bei mehr
  werden die Balken auf dem Handy zu Strichen.

---

## Tarif-Erinnerungen (`TARIFF_REMINDERS`, ab v1.14.0)

Die Tarifgrössen stehen als Konstanten in `WIEN_TARIFFS` und müssen zu Stichtagen
von Hand nachgezogen werden. Damit das nicht untergeht, blendet das Dashboard ab
dem jeweiligen Datum einen Hinweis ein, bis er quittiert wird.

- `TARIFF_REMINDERS`: `[{ id, from:'YYYY-MM-DD', title, text }]`. `from` ist der Tag,
  ab dem der Hinweis **erscheint**, nicht zwingend der Tag, ab dem die Änderung gilt.
- Quittierte IDs liegen in `settings.remindersDone` – also bewusst **in** `settings`,
  damit sie über `syncToCloud()` auf allen Geräten verschwinden. (Gegenteil von
  `expandedMonths`, das genau deshalb nicht in `settings` liegt.)
- Default `remindersDone: []` gehört in den settings-Merge-Block, sonst wirft
  `dueReminders()` bei Altdaten ohne das Feld.
- Aktuell zwei Einträge, beide ab 2027-01-01: `sne-tv-2027` (neue Netzentgelte inkl.
  Leistungspreis) und `winap-2027` (TODO 5).
- Beim Erledigen eines Punktes gehört der zugehörige Reminder entfernt – sonst bleibt
  er als Karteileiche stehen und wird irgendwann weggeklickt statt gelesen.

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

---

## Trip-Reports (`src/`, ab v1.16.0)

Reise-Reports aus Ladebelegen. Neue Teile liegen als **ES-Module unter `src/`**
und werden von `index.html` als zweites, eigenes `<script type="module">`
geladen. `script.js` bleibt ein klassisches Script und wird **nicht** umgebaut –
die Module greifen über die globalen Funktionen darauf zu (`calcTotal`,
`energyPriceFor`, `benzinPreis`, `fmt`, …). Kein Build-Schritt: GitHub Pages
liefert `src/` unverändert aus. Die `package.json` im Root ist reine
Entwicklungsinfrastruktur (Vitest, pdf.js für das Fixture-Werkzeug).

**pdf.js** kommt per Dynamic Import von jsDelivr, erst beim Öffnen der
Trip-Ansicht (`src/lib/pdf.js`). Version ist in `PDFJS_VERSION` gepinnt. Der
Start des Ladefuchs wird dadurch nicht langsamer.

### Textextraktion (`itemsToLines`)

`getTextContent()` liefert Fragmente mit Position, keine Zeilen. Ein
`items.map(i => i.str).join(' ')` zerstört die Tabellenstruktur, an der alle
Parser hängen. Stattdessen: nach Y-Koordinate zu Zeilen bündeln (PDF-Ursprung
unten links → absteigend), innerhalb der Zeile nach X sortieren, und beim
Zusammenfügen die Lücke bewerten – **grosse Lücke = `\t` (Spalte)**, kleine =
Leerzeichen. Die Schwelle hängt an der Schrifthöhe, nicht an einem absoluten
Wert, sonst kippt sie mit der Schriftgrösse.

Ohne Textebene (Scan) wird abgebrochen statt geraten – kein OCR (Edge Case 9).

### Netto oder brutto? (`src/parsers/verify.js`)

**Die Spec-Tabelle in §4.1 ordnet das dem Aussteller zu. Das stimmt nicht.**
In den vorliegenden Rechnungen ist `Preis/Einheit` bei *Tesla Germany* mal
netto (Lindau `0.436865 × 35.2512 = 15,40` = Teilsumme), mal brutto (Bernau
`0.47 × 89.2064 = 41,92` = Gesamtbetrag) – gleicher Rechtsträger, gleiches
Layout, teils derselbe Monat. Es gibt also keine Regel pro Anbieter, an der
man sich festhalten könnte.

Verlässlich ist stattdessen die Spalte **`Total (EUR)` der Positionszeile: sie
ist netto** und summiert sich zur Teilsumme, nie zum Gesamtbetrag. Der
Bruttobetrag entsteht daraus über den Steuersatz derselben Zeile, gegengeprüft
gegen den ausgewiesenen Gesamtbetrag (±0,02 €). Die Netto/Brutto-Einordnung des
Stückpreises läuft weiter mit (`unitPriceBasis`), aber nur noch als Kontrolle:
passt der Stückpreis zu keiner der beiden Summen, wird die Zeile mit
`needsReview` markiert statt still geraten.

Angezeigt wird immer `grossTotal / kwh` – die einzige über alle Anbieter
vergleichbare Zahl.

### Zahlen (`src/lib/num.js`)

`parseDecimal()` steht **neben** `parseNum()` aus dem CSV-Import, ersetzt es
nicht. `parseNum()` setzt voraus, dass in einer Datei entweder Komma oder Punkt
der Dezimaltrenner ist; für Rechnungen gilt das nicht (IONITY mischt beides in
einer Zeile). Heuristik: das letzte Trennzeichen ist der Dezimalpunkt, ausser es
folgen exakt drei Ziffern **und** es gibt ein weiteres Trennzeichen desselben
Zeichens (`1.234.567` → 1234567, aber `1.234,567` → 1234.567 und `26,707` →
26,707). Gibt `null` statt `NaN` zurück, damit niemand versehentlich
weiterrechnet.

### Toleranz der Netto/Brutto-Prüfung

Die festen ±0,02 € der Spec reichen nur, solange der Stückpreis genau genug
gedruckt ist. IONITY weist `0.80 EUR/KWH` aus, abgerechnet werden 0,8035 –
bei 26,707 kWh sind das 9 Cent Abweichung, und jede IONITY-Rechnung wäre
fälschlich prüfbedürftig. `priceTolerance()` skaliert deshalb mit der Menge
und der gedruckten Genauigkeit (`Menge × 0,5 × 10⁻ⁿ`, mindestens 0,02 €).
`decimalsOf()` in `num.js` liefert das n – die *gedruckten* Nachkommastellen,
nicht die signifikanten.

### Parser-Interface

`{ id, label, detect(text) -> boolean, parse(text) -> Charge[] }`, registriert
in `src/parsers/index.js`. `parseInvoiceText()` wirft nie – eine kaputte Datei
darf einen Mehrfach-Import nicht abbrechen, sie geht als `unrecognized` durch.
Die Charge-`id` ist deterministisch (`anbieter:rechnungsnummer:datum`), damit
dieselbe Rechnung zweimal eingelesen nicht doppelt zählt (Edge Case 7).

Eine Tesla-Rechnung deckt einen Ladestopp ab; mehrere Positionszeilen sind
Tarifstufen derselben Session und werden nach Event-Datum zusammengefasst
(Minutentarif: „Stufe 2" 1 min + „Stufe 3" 11 min = 12 min / 11,40 €).

`buildCharge()` in `charge.js` hält die Feldliste an einer Stelle und setzt
die Regeln durch, die für alle Anbieter gelten (`grossPerKwh` immer aus
`grossTotal / kwh`, fehlende Menge bleibt `null` + `estimated`).
`toIsoDate()` parst `TT/MM/JJJJ` bewusst selbst – `new Date('10/07/2026')`
läse daraus den 7. Oktober statt den 10. Juli.

### Die anderen drei Anbieter

**IONITY** (italienische Niederlassung): eine Positionszeile je Session,
`<Ort> <TT/MM/JJJJ>: 0.80 EUR/KWH ⇥ 26,707 KWH ⇥ 3,87 EUR (22,00 %) ⇥ 17,59 EUR`.
Der Betrag der Zeile ist netto, die Steuer steht daneben – brutto entsteht als
Summe der beiden, **nicht** über den Satz gerechnet, sonst geht die Cent-Rundung
der Rechnung verloren.

**Electra**: Label und Wert auf derselben Zeile, Übersetzung in der nächsten.
Die Betragsspalte ist laut Kopf „Preis (inkl. Steuern)", also brutto. Das
Stückpreis-Feld ist 0,00 € und damit unbrauchbar – hier gibt es nichts zu
verifizieren (`unitPriceBasis: 'unknown'` ist der Normalfall, kein Mangel).
Der Ladeort steht nicht im Kopf, sondern unten im Zahlungsblock in der Zeile
nach `<Datum> à <Uhrzeit> - <Dauer>`. Die Rechnungsnummer bricht um.

**EWE Go**: Monats-Sammelrechnung, eine Zeile für einen ganzen Leistungs-
zeitraum. Daraus ist nicht ableitbar, welche Ladung wann und wo war, und eine
Monatsrechnung enthält regelmässig Ladungen ausserhalb des Trips (Edge Case 3).
Deshalb genau **eine** Charge mit `isAggregate: true`; `grossPerKwh` ist hier
nicht nur Anzeige, sondern der Umrechnungssatz, mit dem das Split-UI die kWh
der Einzelsessions zurückrechnet.

**Minutentarif:** `kwh: null` und `estimated: true` – nie `0`. Die Rechnung
nennt keine kWh, geschätzt wird im UI, nicht im Parser (gleiche Logik wie beim
`maxKw`-Peak-Tracker: fehlender Messwert ist nicht null).

### Tests

`npm test` (Vitest). Fixtures in `fixtures/` sind anonymisierte Textextrakte
echter Rechnungen, erzeugt über `npm run dump-pdf` – dasselbe `itemsToLines()`
wie zur Laufzeit, damit Fixture und Browser nicht auseinanderlaufen.

---

## Trip-Ansicht (`src/trips/`, ab v1.16.0)

Vierter Nav-Eintrag „Trips" mit zwei Seiten: `page-trips` (Liste) und
`page-trip-detail` (Report). Beide stehen leer in `index.html` und werden per
`innerHTML` gefüllt – dasselbe Muster wie `page-detail`.

**Die Brücke (`window.lfBridge`).** `charges`, `settings`, `db`,
`firebaseReady`, `HOUSEHOLD_DOC` und `fmt` sind in `script.js` mit
`let`/`const` deklariert und liegen deshalb **nicht** auf `window` – anders
als Funktionsdeklarationen wie `calcTotal` oder `showToast`. Ein Inline-Script
in `index.html` reicht sie als **Getter** durch (keine Kopien: `loadFromCloud()`
weist `charges` neu zu). `script.js` selbst bleibt unangetastet.

**Persistenz (`store.js`).** Sub-Collection `haushalte/haushalt/trips`, ein
Dokument je Trip, plus localStorage-Spiegel (`lf_trips`). Ausdrücklich **kein**
Feld am Haushalt-Dokument: `syncToCloud()` schreibt dort mit `.set()` ohne
`{merge:true}` und würde es beim nächsten Nutzer-Sync löschen. Sub-Collections
sind davon nicht betroffen – der Preis ist, dass Laden und Schreiben hier
eigenständig passieren, nicht über `persist()`. Geladen wird erst beim Öffnen
der Trip-Ansicht. Vor dem Schreiben geht alles durch `JSON.parse(JSON.stringify())`:
Firestore lehnt `undefined` ab.

**Heimladungen werden referenziert, nie kopiert** (Spec §5): der Trip hält nur
`homeChargeIds`, die Ladung bleibt in `charges[]`. Sonst zeigt das Dashboard
andere Zahlen als der Report. Eine von Hand geänderte Fahrtrichtung liegt
deshalb in `trip.homeLegs`, nicht am Bestandseintrag.

**Aggregation (`calc.js`)** ist frei von Globals – alles kommt als Argument,
damit die Rechnung ohne Browser testbar ist. Der Integrationstest fährt den
Caorle-Trip aus §10 durch: 264,09 kWh / 106,44 € / 22,5 kWh/100km.

**Verbrenner-Vergleich als Spanne**, nie als Punktwert – es ist eine Schätzung.
Untergrenze ist `comp_benzin_verbrauch_l` (der Wert, mit dem auch das Dashboard
rechnet), Obergrenze das neue `comp_benzin_verbrauch_l_max` (Default 9,5).
Zwei Felder, weil der Alltagsverbrauch nicht der Langstreckenverbrauch ist.

**Minutentarif:** `kwh` bleibt `null`, `effectiveKwh()` fällt auf einen im UI
gesetzten `kwhEstimate` zurück. Vorschlag ist Dauer × `DEFAULT_ESTIMATE_KW`
(90 kW). Geschätzte Werte tragen im Report ein Badge und ein `*` an den Summen.

**Edge Cases im UI:** Rechnung ausserhalb des Reisezeitraums wird nachgefragt
statt still zugeordnet (8, Toleranz ein Tag je Seite – die Heimladung am
Vorabend ist normal); doppelt abgelegte Rechnungen fallen über die
deterministische Charge-`id` raus (7); eine fehlende Heimladung und eine noch
nicht aufgeteilte Sammelrechnung erscheinen als Warnung im Report (5, 3).

**Noch offen:** Split-UI für Sammelrechnungen (Spec §8 – `splitAggregate()` in
`calc.js` ist fertig und getestet, es fehlt die Eingabemaske), Vergleichsansicht
über alle Trips (§9), Claude-Fallback (§7).
