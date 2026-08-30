import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseInvoiceText } from './index.js';
import { classifyUnitPrice, priceTolerance } from './verify.js';

const fixture = name =>
  readFileSync(fileURLToPath(new URL(`../../fixtures/${name}.txt`, import.meta.url)), 'utf8');

const single = name => {
  const r = parseInvoiceText(fixture(name), { fileName: `${name}.pdf` });
  expect(r.unrecognized).toBe(false);
  expect(r.charges).toHaveLength(1);
  return r.charges[0];
};

describe('IONITY', () => {
  const c = () => single('ionity-it-bagnaria-arsa');

  it('wird als IONITY erkannt und nicht von einem anderen Parser gegriffen', () => {
    expect(parseInvoiceText(fixture('ionity-it-bagnaria-arsa')).parserId).toBe('ionity');
  });

  it('liest Ort, Datum und Menge aus der Positionszeile', () => {
    expect(c().location).toBe('Bagnaria Arsa');
    // 10/07/2026 ist der 10. Juli, nicht der 7. Oktober.
    expect(c().date).toBe('2026-07-10');
    expect(c().kwh).toBe(26.707);
  });

  it('verkraftet den Dezimaltrenner-Mix innerhalb einer Zeile (Edge Case 10)', () => {
    // Punkt beim kWh-Preis (0.80), Komma bei Menge und Beträgen (26,707 / 17,59).
    expect(fixture('ionity-it-bagnaria-arsa')).toMatch(/0\.80 EUR\/KWH/);
    expect(c().kwh).toBe(26.707);
    expect(c().netTotal).toBe(17.59);
  });

  it('bildet den Bruttobetrag aus Netto plus ausgewiesener Steuer', () => {
    // 17,59 + 3,87 = 21,46. Über den Satz gerechnet käme 21,4598 heraus –
    // die Rechnung hat bereits gerundet.
    expect(c().grossTotal).toBe(21.46);
    expect(c().vatRate).toBeCloseTo(0.22, 10);
    expect(c().grossPerKwh).toBeCloseTo(0.804, 3);
  });

  it('meldet den gerundeten Stückpreis nicht als Fehler', () => {
    // 0.80 × 26,707 = 21,37 gegen 21,46 brutto: 9 Cent daneben, also weit
    // ausserhalb der starren ±0,02 € – aber innerhalb dessen, was ein auf
    // zwei Stellen gedruckter Preis an Rundung tragen kann.
    expect(c().unitPriceBasis).toBe('gross');
    expect(c().needsReview).toBe(false);
  });
});

describe('Electra', () => {
  const c = () => single('electra-at-villach');

  it('liest Menge und Bruttobetrag', () => {
    expect(c().kwh).toBe(10.315);
    expect(c().grossTotal).toBe(7.12);
    expect(c().netTotal).toBe(5.93);
    expect(c().grossPerKwh).toBeCloseTo(0.690, 3);
    expect(c().vatRate).toBeCloseTo(0.2, 10);
  });

  it('holt den Ladeort aus dem Zahlungsblock, nicht aus dem Kopf', () => {
    // Der Ort steht in der Zeile nach „<Datum> à <Uhrzeit> - <Dauer>".
    expect(c().location).toBe('Villach - Pizza Plus');
    expect(c().date).toBe('2026-07-14');
  });

  it('ignoriert das unbrauchbare Stückpreis-Feld', () => {
    // Electra druckt dort 0,00 € – daraus lässt sich nichts verifizieren,
    // also wird es auch nicht als Netto/Brutto-Hinweis ausgegeben.
    expect(fixture('electra-at-villach')).toMatch(/0,00 €/);
    expect(c().unitPriceBasis).toBe('unknown');
    expect(c().needsReview).toBe(false);
  });

  it('setzt die über zwei Zeilen umbrechende Rechnungsnummer zusammen', () => {
    expect(c().invoiceNumber).toBe('AT-UN20260714-000024');
  });
});

describe('EWE Go – Sammelrechnung', () => {
  const c = () => single('ewe-go-sammelrechnung');

  it('erzeugt genau eine Charge und markiert sie als Aggregat', () => {
    // Eine Monatsrechnung ist keine Ladung. Ohne diese Markierung würde der
    // Trip 134,756 kWh zählen, darunter Ladungen, die nicht dazugehören.
    expect(c().isAggregate).toBe(true);
    expect(c().location).toBeNull();
  });

  it('liest Menge, Beträge und Leistungszeitraum', () => {
    expect(c().kwh).toBe(134.756);
    expect(c().netTotal).toBe(58.88);
    expect(c().grossTotal).toBe(70.07);
    expect(c().periodStart).toBe('2026-04-01');
    expect(c().periodEnd).toBe('2026-04-30');
  });

  it('liefert den €/kWh-Satz für die spätere Aufteilung', () => {
    // Über diesen Satz rechnet das Split-UI die kWh der Einzelsessions zurück.
    expect(c().grossPerKwh).toBeCloseTo(0.520, 3);
  });

  it('erkennt den Stückpreis als netto', () => {
    // 0,436975 × 134,756 = 58,88 = Gesamt Netto.
    expect(c().unitPriceBasis).toBe('net');
    expect(c().needsReview).toBe(false);
  });
});

// Die feste Toleranz aus §4.1 trägt nur, solange der Stückpreis genau genug
// gedruckt ist. Sie muss mit der Menge und der Rundung mitwachsen.
describe('priceTolerance', () => {
  it('bleibt bei genauen Stückpreisen bei ±0,02 €', () => {
    expect(priceTolerance(35.2512, 6)).toBeCloseTo(0.02, 10);
  });

  it('wächst bei grob gerundeten Stückpreisen mit der Menge', () => {
    expect(priceTolerance(26.707, 2)).toBeCloseTo(0.1335, 4);
    expect(priceTolerance(89.2064, 2)).toBeCloseTo(0.4460, 4);
  });

  it('trennt netto und brutto trotz weiterer Toleranz noch sauber', () => {
    // IONITY: 0.80 × 26,707 = 21,3656 – nah an brutto 21,46, weit weg von
    // netto 17,59. Die Antwort bleibt eindeutig.
    expect(classifyUnitPrice({
      unitPrice: 0.8, quantity: 26.707, netTotal: 17.59, grossTotal: 21.46, unitPriceDecimals: 2,
    })).toBe('gross');
  });

  it('meldet unbrauchbare Stückpreise weiterhin als unknown', () => {
    expect(classifyUnitPrice({
      unitPrice: 0.999999, quantity: 35.2512, netTotal: 15.40, grossTotal: 18.33, unitPriceDecimals: 6,
    })).toBe('unknown');
  });
});

// Ein Ergebnis, das die Spec-Tabelle in §4.1 so nicht hergibt: die Bedeutung
// von „Preis/Einheit" ist keine Eigenschaft des Ausstellers.
describe('Netto/Brutto über alle Anbieter', () => {
  it('ist bei Tesla Germany je nach Rechnung verschieden', () => {
    const basis = n => single(n).unitPriceBasis;
    expect(basis('tesla-de-lindau')).toBe('net');
    expect(basis('tesla-de-bernau-theodor-sanne')).toBe('gross');
  });

  it('liefert für jede Rechnung einen belastbaren Bruttopreis je kWh', () => {
    const erwartet = {
      'tesla-de-lindau': 0.520,
      'tesla-de-irschenberg': 0.580,
      'tesla-de-bernau-theodor-sanne': 0.470,
      'tesla-de-bernau-hochfellnstrasse': 0.410,
      'tesla-it-noventa-di-piave': 0.490,
      'tesla-at-voelkermarkt-hinfahrt': 0.330,
      'tesla-at-voelkermarkt-rueckfahrt': 0.330,
      'ionity-it-bagnaria-arsa': 0.804,
      'electra-at-villach': 0.690,
      'ewe-go-sammelrechnung': 0.520,
    };
    for (const [name, wert] of Object.entries(erwartet)) {
      expect(single(name).grossPerKwh, name).toBeCloseTo(wert, 3);
    }
  });
});
