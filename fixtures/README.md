# Testdaten für die Rechnungs-Parser

Textextrakte echter Ladebelege, **anonymisiert**. Erzeugt mit dem Werkzeug,
das auch die App verwendet:

```
npm run dump-pdf -- rechnung.pdf > fixtures/anbieter-ort.txt
```

`tools/dump-pdf.mjs` ruft dasselbe `itemsToLines()` auf wie `src/lib/pdf.js`
zur Laufzeit. Fixtures und Browser sehen deshalb denselben Text – ein Parser,
der hier grün ist, ist es auch in der App.

## Format

Eine Zeile je Textzeile des PDF. **Tabulatoren trennen Tabellenspalten**,
Leerzeichen trennen Wörter. Beim Bearbeiten die Tabs erhalten – ohne sie
verlieren die Parser die Spaltenstruktur.

## Vor dem Commit anonymisieren

Rechnungen enthalten Klarnamen, Anschrift, E-Mail und Kundennummer. Ersetzt
werden: Name → `Max Mustermann`, Anschrift → `Musterstraße 1/2/3` /
`1010 Wien AT`, E-Mail → `max.mustermann@example.com`, Kundennummer →
`3000000000`, Rechnungs- und Referenznummer → Dummy-Werte, Ladesäulen-S/N →
maskiert. Beträge, Mengen, Datum, Ort und Steuersätze bleiben **unverändert** –
sie sind der Prüfgegenstand.

## Bestand

| Datei | Besonderheit |
|---|---|
| `tesla-at-stpoelten-minutentarif.txt` | Minutentarif, zwei Tarifstufen, **keine kWh** auf der Rechnung |
| `tesla-de-lindau.txt` | Stückpreis ist **netto** (0.436865 × 35.2512 = Teilsumme 15,40) |
| `tesla-de-irschenberg.txt` | Stückpreis netto; Mengenzelle **bricht über drei Zeilen um** |
| `tesla-de-bernau-theodor-sanne.txt` | Stückpreis ist **brutto** (0.47 × 89.2064 = Gesamtbetrag 41,92) |
| `tesla-de-bernau-hochfellnstrasse.txt` | Stückpreis brutto; zweiter Standort im selben Ort |

Fehlen noch: IONITY, Electra, EWE Go. Für Tesla Italy liegt keine echte
Rechnung vor – der Fall steckt als synthetisches Beispiel in
`src/parsers/tesla.test.js`.
