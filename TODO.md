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

**Kontext (nicht app-relevant, aber im selben Entwurf):**
- Leistungspreis für Haushalte – E-Auto-Laden wird tendenziell günstiger (gleichmäßiger Bezug, keine großen Spitzen).
- Netzgebührenbefreiung für Großspeicher ≥ 1 MW / Aggregatoren ≥ 50 kW – für uns irrelevant.
