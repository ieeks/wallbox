import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import tesla from './tesla.js';

const fixture = name =>
  readFileSync(fileURLToPath(new URL(`../../fixtures/${name}.txt`, import.meta.url)), 'utf8');

const single = name => {
  const charges = tesla.parse(fixture(name));
  expect(charges).toHaveLength(1);
  return charges[0];
};

describe('Tesla – Erkennung', () => {
  it('erkennt alle vorliegenden Rechnungen', () => {
    for (const name of [
      'tesla-at-stpoelten-minutentarif',
      'tesla-de-lindau',
      'tesla-de-irschenberg',
      'tesla-de-bernau-theodor-sanne',
      'tesla-de-bernau-hochfellnstrasse',
      'tesla-it-noventa-di-piave',
    ]) {
      expect(tesla.detect(fixture(name))).toBe(true);
    }
  });

  it('trennt die Rechtsträger über die USt-IdNr', () => {
    expect(single('tesla-at-stpoelten-minutentarif').provider).toBe('tesla-at');
    expect(single('tesla-de-lindau').provider).toBe('tesla-de');
  });

  it('greift nicht auf fremde Rechnungen zu', () => {
    expect(tesla.detect('IONITY GmbH – Fattura – 26,707 KWH')).toBe(false);
    expect(tesla.detect('')).toBe(false);
  });
});

// Prüfziel laut Spec §10: grossTotal und kwh exakt, grossPerKwh auf drei
// Nachkommastellen. Die Sollwerte stammen aus den Rechnungen selbst.
describe('Tesla – Beträge', () => {
  const faelle = [
    { name: 'tesla-de-lindau',                  kwh: 35.2512, gross: 18.33, perKwh: 0.520, ort: 'Lindau (Bodensee)' },
    { name: 'tesla-de-irschenberg',             kwh: 76.4702, gross: 44.35, perKwh: 0.580, ort: 'Irschenberg' },
    { name: 'tesla-de-bernau-theodor-sanne',    kwh: 89.2064, gross: 41.92, perKwh: 0.470, ort: 'Bernau am Chiemsee – Theodor-Sanne-Straße' },
    { name: 'tesla-de-bernau-hochfellnstrasse', kwh: 14.1028, gross: 5.78,  perKwh: 0.410, ort: 'Bernau am Chiemsee – Hochfellnstraße' },
  ];

  for (const f of faelle) {
    it(`${f.name}: ${f.kwh} kWh / ${f.gross} €`, () => {
      const c = single(f.name);
      expect(c.kwh).toBe(f.kwh);
      expect(c.grossTotal).toBe(f.gross);
      expect(c.grossPerKwh).toBeCloseTo(f.perKwh, 3);
      expect(c.location).toBe(f.ort);
      expect(c.needsReview).toBe(false);
      expect(c.estimated).toBe(false);
    });
  }

  it('setzt grossPerKwh aus grossTotal/kwh, nie aus dem Stückpreis der Rechnung', () => {
    // Lindau nennt 0.436865 €/kWh – das ist der Nettopreis. Vergleichbar ist
    // nur der Bruttopreis, und der liegt bei 0,520.
    const c = single('tesla-de-lindau');
    expect(c.grossPerKwh).toBeCloseTo(0.52, 3);
    expect(c.grossPerKwh).not.toBeCloseTo(0.436865, 3);
  });

  it('liest Datum, Ort und Rechnungsnummer', () => {
    const c = single('tesla-de-irschenberg');
    expect(c.date).toBe('2026-04-10');
    expect(c.invoiceDate).toBe('2026-04-10');
    expect(c.invoiceNumber).toBe('4020P0000000004');
    expect(c.vatRate).toBeCloseTo(0.19, 10);
  });
});

// Der Kern von §4.1: derselbe Rechtsträger, dasselbe Layout, derselbe Monat –
// und `Preis/Einheit` bedeutet trotzdem mal netto, mal brutto. Deshalb wird
// gerechnet statt am Aussteller entschieden.
describe('Tesla – Netto/Brutto des Stückpreises', () => {
  it('erkennt einen Nettopreis (0.436865 × 35.2512 = Teilsumme 15,40)', () => {
    expect(single('tesla-de-lindau').unitPriceBasis).toBe('net');
    expect(single('tesla-de-irschenberg').unitPriceBasis).toBe('net');
  });

  it('erkennt einen Bruttopreis (0.47 × 89.2064 = Gesamtbetrag 41,92)', () => {
    expect(single('tesla-de-bernau-theodor-sanne').unitPriceBasis).toBe('gross');
    expect(single('tesla-de-bernau-hochfellnstrasse').unitPriceBasis).toBe('gross');
  });

  it('rechnet den Bruttobetrag unabhängig davon korrekt', () => {
    // Beide Rechnungen sind gleich aufgebaut, die Bedeutung des Stückpreises
    // unterscheidet sich – der Bruttobetrag stimmt trotzdem in beiden Fällen.
    expect(single('tesla-de-lindau').grossTotal).toBe(18.33);
    expect(single('tesla-de-bernau-theodor-sanne').grossTotal).toBe(41.92);
  });
});

describe('Tesla – Minutentarif (Edge Case 1)', () => {
  const c = () => single('tesla-at-stpoelten-minutentarif');

  it('liefert keine kWh, sondern eine Schätzmarkierung', () => {
    expect(c().kwh).toBeNull();
    expect(c().grossPerKwh).toBeNull();
    expect(c().estimated).toBe(true);
  });

  it('fasst die Tarifstufen einer Session zusammen', () => {
    // „Stufe 2" 1 min + „Stufe 3" 11 min = 12 min, 0,52 + 8,98 netto = 9,50.
    expect(c().minutes).toBe(12);
    expect(c().netTotal).toBe(9.5);
    expect(c().grossTotal).toBe(11.4);
    expect(c().vatRate).toBeCloseTo(0.2, 10);
  });

  it('meldet trotz fehlender kWh keinen Prüfbedarf', () => {
    // Ein Minutentarif ist ein bekannter Zustand, kein Lesefehler.
    expect(c().needsReview).toBe(false);
  });
});

describe('Tesla – umgebrochene Mengenzelle', () => {
  it('findet die Menge, wenn sie im PDF auf eigene Zeilen umbricht', () => {
    // Bei Irschenberg steht „76.4702" über und „kWh" unter der Positionszeile;
    // die Zeile selbst hat nur fünf statt sechs Zellen.
    const roh = fixture('tesla-de-irschenberg');
    expect(roh).toMatch(/^76\.4702$/m);
    expect(roh).toMatch(/^kWh$/m);
    expect(single('tesla-de-irschenberg').kwh).toBe(76.4702);
  });
});

describe('Tesla – Italien', () => {
  it('erkennt den italienischen Rechtsträger und rechnet mit 22 % IVA', () => {
    const c = single('tesla-it-noventa-di-piave');
    expect(c.provider).toBe('tesla-it');
    expect(c.kwh).toBe(47.7272);
    expect(c.grossTotal).toBe(23.38);
    expect(c.grossPerKwh).toBeCloseTo(0.490, 3);
    expect(c.vatRate).toBeCloseTo(0.22, 10);
    expect(c.unitPriceBasis).toBe('net');
    expect(c.location).toBe('Noventa di Piave');
    expect(c.needsReview).toBe(false);
  });
});

describe('Tesla – Prüfbedarf statt stillem Raten', () => {
  it('markiert eine Zeile, deren Stückpreis zu keiner der Summen passt', () => {
    const kaputt = fixture('tesla-de-lindau').replace('0.436865 / kWh', '0.999999 / kWh');
    const [c] = tesla.parse(kaputt);
    expect(c.unitPriceBasis).toBe('unknown');
    expect(c.needsReview).toBe(true);
    expect(c.reviewReasons.join(' ')).toMatch(/weder Teilsumme noch Gesamtbetrag/);
  });

  it('markiert eine Rechnung, deren Positionen nicht zum Gesamtbetrag summieren', () => {
    const kaputt = fixture('tesla-de-lindau').replace('Gesamtbetrag (EUR)\t18.33', 'Gesamtbetrag (EUR)\t99.99');
    const [c] = tesla.parse(kaputt);
    expect(c.needsReview).toBe(true);
    expect(c.reviewReasons.join(' ')).toMatch(/weicht vom Gesamtbetrag/);
  });

  it('liefert eine leere Liste, wenn keine Positionstabelle da ist', () => {
    expect(tesla.parse('Tesla Germany GmbH\nStromgebühr\nkein Tabellenkopf')).toEqual([]);
  });
});
