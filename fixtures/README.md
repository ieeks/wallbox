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

Rechnungen enthalten Klarnamen, Anschrift, Kunden- und Vertragsnummern.
Ersetzt werden: Name → `Max Mustermann`, Anschrift → `Musterstraße 1/2/3` /
`1010 Wien AT`, E-Mail → `max.mustermann@example.com`, Kunden-, Rechnungs-,
Referenz- und Vertragsnummern → Dummy-Werte, Ladesäulen-S/N und
Kartenendziffern → maskiert. Beträge, Mengen, Datum, Ort und Steuersätze
bleiben **unverändert** – sie sind der Prüfgegenstand.

## Bestand

| Datei | Anbieter | Besonderheit |
|---|---|---|
| `tesla-at-stpoelten-minutentarif.txt` | Tesla AT | Minutentarif, zwei Tarifstufen, **keine kWh** auf der Rechnung |
| `tesla-de-lindau.txt` | Tesla DE | Stückpreis **netto** (0.436865 × 35.2512 = Teilsumme 15,40) |
| `tesla-de-irschenberg.txt` | Tesla DE | Stückpreis netto; Mengenzelle **bricht über drei Zeilen um** |
| `tesla-de-bernau-theodor-sanne.txt` | Tesla DE | Stückpreis **brutto** (0.47 × 89.2064 = Gesamtbetrag 41,92) |
| `tesla-de-bernau-hochfellnstrasse.txt` | Tesla DE | Stückpreis brutto; zweiter Standort im selben Ort |
| `tesla-it-noventa-di-piave.txt` | Tesla IT | 22 % IVA, sonst identisches Layout |
| `tesla-at-voelkermarkt-hinfahrt.txt` | Tesla AT | 20 % USt; zusammen mit der Rückfahrt zwei Ladungen am selben Standort |
| `tesla-at-voelkermarkt-rueckfahrt.txt` | Tesla AT | das Beispiel aus Spec §4.1 (0,274980 × 68,5208 = 18,84 netto) |
| `ionity-it-bagnaria-arsa.txt` | IONITY | **Dezimaltrenner-Mix in einer Zeile**; Stückpreis auf 2 Stellen gerundet |
| `electra-at-villach.txt` | Electra | Stückpreis-Feld ist 0,00 €; Ladeort steht im Zahlungsblock; Rechnungsnummer bricht um |
| `ewe-go-sammelrechnung.txt` | EWE Go | **Monats-Sammelrechnung**, eine Zeile für einen ganzen Leistungszeitraum |

Der Integrationstest über einen kompletten Trip (Spec §10: 264,09 kWh /
106,44 € bei 1172 km) läuft damit vollständig aus echten Rechnungen – nur die
Heimladung kommt, wie in der App, aus dem Ladefuchs-Bestand statt aus einer PDF.
