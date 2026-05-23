# TODO

## [ ] 1. Einträge bearbeiten (Edit)

Aktuell können Einträge nur gelöscht werden. Ein Edit-Modus soll erlauben, kWh, Datum, Uhrzeit und Energiepreis nachträglich zu korrigieren.

- Edit-Button in History-Item und Detailseite
- Vorbelegt mit bestehenden Werten
- Speichern überschreibt den Eintrag (inkl. Neuberechnung der Kosten/SNAP)

---

## [ ] 2. go-e Live-Status Card

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

## [ ] 4. Monats-Statistik Seite / Tabelle

Übersichtstabelle pro Monat:

| Monat | Ladungen | kWh | Kosten | Ø ct/kWh | SNAP-Anteil | Ersparnis |
|---|---|---|---|---|---|---|

- Neue Seite oder Abschnitt in der Gesamtansicht
- Sortierbar nach Monat (neueste zuerst)
- Klick auf Monat → filtert Dashboard auf diesen Monat
