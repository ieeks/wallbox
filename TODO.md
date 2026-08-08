# TODO

## [x] 1. Einträge bearbeiten (Edit)

Aktuell können Einträge nur gelöscht werden. Ein Edit-Modus soll erlauben, kWh, Datum, Uhrzeit und Energiepreis nachträglich zu korrigieren.

- Edit-Button in History-Item und Detailseite
- Vorbelegt mit bestehenden Werten
- Speichern überschreibt den Eintrag (inkl. Neuberechnung der Kosten/SNAP)

---

## [x] 2. go-e Live-Status Card

Dashboard-Card die zeigt ob das Auto gerade lädt — direkt von der go-e API.

- Zeigt: aktueller Status (`car`), Watt, bisher geladene kWh, laufende Kosten (geschätzt)
- Polling alle ~30 Sek. (nur wenn Tab sichtbar)
- Quelle: `https://{GOE_SERIAL}.api.v3.go-e.io/api/status`
- Card erscheint nur wenn go-e konfiguriert (Serial/Token in Settings)

---

## [x] 3. SNAP-Bug im Auto-Import fixen

In `.github/scripts/goe-import.js` wird SNAP korrekt erkannt, aber **nicht übergeben**:

```js
// BUG: snap ist hardcoded false
const total = calcTotal(kwh, energyPrice, false, gebrauchsabgabe, ust);

// FIX:
const snap = isSnap(date, time);
const total = calcTotal(kwh, energyPrice, snap, gebrauchsabgabe, ust);
```

Alle automatisch importierten SNAP-Sessions haben deshalb falsch berechnete (zu hohe) Kosten. Nach dem Fix müssen betroffene Einträge ggf. manuell neu berechnet werden.

---

## [x] 4. Monats-Statistik Seite / Tabelle

Übersichtstabelle pro Monat:

| Monat | Ladungen | kWh | Kosten | Ø ct/kWh | SNAP-Anteil | Ersparnis |
|---|---|---|---|---|---|---|

- Neue Seite oder Abschnitt in der Gesamtansicht
- Sortierbar nach Monat (neueste zuerst)
- Klick auf Monat → filtert Dashboard auf diesen Monat

---

## [ ] 5. WiNAP – Winter-Nieder-Arbeitspreis

Gegenstück zu SNAP für das Winterhalbjahr. Kommt mit der neuen E-Control
Systemnutzungsentgelte-Grundsatzverordnung (auf Basis des ElWG), **gültig ab 1. Jänner 2027**.
Quelle: E-Control-Entwurf, 30.06.2026 (Begutachtung bis 24.07.2026, endgültige Gebührenhöhen erst im Herbst 2026).

**Regel:** Wer im Winterhalbjahr **Oktober–März** zwischen **22:00 und 4:00 Uhr** lädt,
bekommt einen Rabatt auf die Netzgebühren (analog SNAP –20 % auf Netznutzung).

Umsetzung spiegelt die SNAP-Mechanik:

- `isWinap(date, time, durationMs, anchor)` parallel zu `isSnap()`
  - Monate: Okt (9) – Mär (2), **nachtübergreifendes** Fenster 22:00–04:00
  - Erst ab Ladedatum ≥ 2027-01-01 anwenden
- `winap`-Flag pro Ladung; `calcTotal()` um WiNAP-Rabatt erweitern
- `WIEN_TARIFFS.winap_rabatt` (Platzhalter, bis echter Satz im Herbst feststeht)
- UI: Badge/Insight analog SNAP (❄️), Rechner (`renderCalc`), Detailseite, Monats-Statistik
- Auto-Import (`.github/scripts/goe-import.js`): `winap` mitgeben (nicht wie SNAP-Bug vergessen)
- Migration analog `migrateSnapTiming` für bestehende Winter-Nachtladungen ab 2027

**Blocker:** Rabattsatz noch nicht final; gilt erst ab 01.01.2027 → vorher auf keine Ladung anwenden.

**Offene Frage zum Startdatum (Stand 08.08.2026):** Die Verordnung tritt am 01.01.2027 in Kraft.
In der Begutachtung stand aber der Vorschlag, WiNAP **erstmals mit dem Winterzeitraum ab 01.10.2027**
anzuwenden. Vor der Umsetzung klären, sonst wird Jan–Mär 2027 falsch gerechnet.

**Erinnerung ist eingebaut** (ab v1.14.0): `TARIFF_REMINDERS` in `script.js` blendet ab 01.01.2027
einen Hinweis im Dashboard ein, bis er quittiert wird. Wird dieser Punkt hier erledigt, gehört
auch der Reminder `winap-2027` entfernt.

**Kontext aus demselben Entwurf:**
- Netzgebührenbefreiung für Großspeicher ≥ 1 MW / Aggregatoren ≥ 50 kW – für uns irrelevant.

---

## [ ] 6. Leistungspreis ab 2027 in die Kostenrechnung

`calcTotal()` rechnet rein arbeitspreisbasiert. Ab 01.01.2027 hängt ein wesentlicher Teil der
Netzkosten nicht mehr an den kWh, sondern am **höchsten 15-Minuten-Mittel des Monats**
(SNE-G-V, Netzebene 7). Das fehlt in der App komplett.

- Zielaufteilung laut E-Control: ca. 50 % Leistungspreis / 50 % Arbeitspreis, gestaffelt über
  3 Jahre (Einstieg grob 30/70).
- Staffel: bis 10 kW niedrigerer Satz, darüber höherer (`PEAK_THRESHOLD_KW` gibt es schon).
- Mindestverrechnung: 20 % der vereinbarten netzwirksamen Leistung, mindestens 2 kW.
- Kostenrechnung ist bisher **pro Ladung**; der Leistungspreis ist **pro Monat**. Das passt nicht
  aufeinander – vermutlich eine getrennte Monatsposition statt einer Umlage auf einzelne Ladungen.
- `maxKw` liegt seit v1.10.3 (Peak-Tracker) bzw. v1.11.0 (CSV-Backfill) vor, das Monats-Peak-
  Diagramm (v1.13.0) zeigt es bereits.

**Blocker:** €/kW-Beträge für das Netzgebiet Wiener Netze kommen erst mit der SNE-T-V
(Entwurf Okt 2026, erlassen Dez 2026).

**Achtung – frühere Einschätzung war für diesen Haushalt falsch:** Hier stand mal, E-Auto-Laden
werde „tendenziell günstiger". Das gilt nur bei gleichmäßigem Bezug. Die E-Control modelliert für
E-Auto-Haushalte, die unverändert mit 11 kW laden, **+21 %** Netzkosten (bei flexiblem Laden −8,5 %).
Die eigenen Daten zeigen 3 von 6 Monaten über 10 kW (Apr 10,58 / Jun 10,55 / Aug 10,62 kW) –
also der teure Fall, nicht der günstige.

---

## [ ] 7. Firestore Security Rules

`haushalte/haushalt` ist ohne Authentifizierung über die REST-API les- **und schreibbar** –
der öffentliche API-Key aus `script.js` genügt. Unabhängig von allen Tarifthemen, aber der
gewichtigste offene Punkt.
