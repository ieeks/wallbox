import { describe, it, expect } from 'vitest';
import { parseDecimal, decimalsOf, round, approxEqual } from './num.js';

describe('parseDecimal', () => {
  it('liest deutsche Beträge mit Tausenderpunkt', () => {
    expect(parseDecimal('1.234,56')).toBe(1234.56);
    expect(parseDecimal('1.234.567,89')).toBe(1234567.89);
  });

  it('liest englische Beträge mit Tausenderkomma', () => {
    expect(parseDecimal('1,234.56')).toBe(1234.56);
    expect(parseDecimal('1,234,567.89')).toBe(1234567.89);
  });

  // Der Fall aus der IONITY-Rechnung: „26,707 KWH" sind 26,707 kWh und nicht
  // 26707. Ein einzelnes Trennzeichen mit drei Nachkommastellen ist Dezimal.
  it('liest eine kWh-Menge mit drei Nachkommastellen als Dezimalzahl', () => {
    expect(parseDecimal('26,707')).toBe(26.707);
    expect(parseDecimal('10,315')).toBe(10.315);
    expect(parseDecimal('1.234')).toBe(1.234);
  });

  it('erkennt reine Gruppierung nur bei gleichem Trennzeichen', () => {
    expect(parseDecimal('1.234.567')).toBe(1234567);
    expect(parseDecimal('1,234,567')).toBe(1234567);
    // Gemischt: das letzte Zeichen ist der Dezimaltrenner, nie ein zweiter
    // Gruppentrenner – sonst würde hieraus 1234567.
    expect(parseDecimal('1.234,567')).toBe(1234.567);
    expect(parseDecimal('1,234.567')).toBe(1234.567);
  });

  it('verkraftet die sechs Nachkommastellen der Tesla-Stückpreise', () => {
    expect(parseDecimal('0,274980')).toBeCloseTo(0.27498, 10);
    expect(parseDecimal('0.436865')).toBeCloseTo(0.436865, 10);
    expect(parseDecimal('0.816364')).toBeCloseTo(0.816364, 10);
  });

  // Beide Schreibweisen kommen in EINER IONITY-Zeile vor:
  // „0.80 EUR/KWH | 26,707 KWH | 3,87 EUR (22,00 %) | 17,59 EUR"
  it('liest gemischte Trenner innerhalb derselben Zeile', () => {
    const zeile = '0.80 EUR/KWH | 26,707 KWH | 3,87 EUR (22,00 %) | 17,59 EUR';
    const zahlen = zeile.split('|').map(t => parseDecimal(t));
    expect(zahlen).toEqual([0.8, 26.707, 3.87, 17.59]);
  });

  it('löst Zahlen aus Währungs- und Einheitentext heraus', () => {
    expect(parseDecimal('€ 1.234,56')).toBe(1234.56);
    expect(parseDecimal('7,12 €')).toBe(7.12);
    expect(parseDecimal('89.2064 kWh')).toBe(89.2064);
    expect(parseDecimal('-0,50')).toBe(-0.5);
    expect(parseDecimal('−0,50')).toBe(-0.5);
  });

  it('gibt null statt NaN zurück, wenn nichts Verwertbares dasteht', () => {
    expect(parseDecimal('')).toBeNull();
    expect(parseDecimal('   ')).toBeNull();
    expect(parseDecimal('keine Zahl')).toBeNull();
    expect(parseDecimal(null)).toBeNull();
    expect(parseDecimal(undefined)).toBeNull();
    expect(parseDecimal(NaN)).toBeNull();
    // Kaputte Gruppierung ist ein Lesefehler, kein Zahlenwert.
    expect(parseDecimal('1..2')).toBeNull();
    expect(parseDecimal('1.23.456')).toBeNull();
  });

  it('reicht endliche Zahlen unverändert durch', () => {
    expect(parseDecimal(42.5)).toBe(42.5);
    expect(parseDecimal(0)).toBe(0);
  });
});

// Wie genau eine Zahl GEDRUCKT ist, ist nicht dasselbe wie ihr Wert – die
// Netto/Brutto-Prüfung braucht das, um den Rundungsspielraum zu kennen.
describe('decimalsOf', () => {
  it('zählt die gedruckten Nachkommastellen, nicht die signifikanten', () => {
    expect(decimalsOf('0.80')).toBe(2);
    expect(decimalsOf('0,436975')).toBe(6);
    expect(decimalsOf('0.47')).toBe(2);
    expect(decimalsOf('1.234,56')).toBe(2);
  });

  it('gibt 0 für ganze Zahlen und reine Gruppierung', () => {
    expect(decimalsOf('19')).toBe(0);
    expect(decimalsOf('1.234.567')).toBe(0);
  });

  it('gibt null, wenn keine Zahl dasteht', () => {
    expect(decimalsOf('keine Zahl')).toBeNull();
  });
});

describe('round', () => {
  it('rundet kaufmännisch ohne Float-Artefakte', () => {
    expect(round(1.005, 2)).toBe(1.01);
    expect(round(2.675, 2)).toBe(2.68);
    expect(round(41.9237, 2)).toBe(41.92);
    expect(round(5.7834, 2)).toBe(5.78);
  });

  it('gibt null für Nicht-Zahlen', () => {
    expect(round(null)).toBeNull();
    expect(round(NaN)).toBeNull();
  });
});

describe('approxEqual', () => {
  it('vergleicht Beträge mit der Toleranz aus §4.1', () => {
    expect(approxEqual(41.9237, 41.92)).toBe(true);
    expect(approxEqual(18.326, 18.33)).toBe(true);
    expect(approxEqual(41.92, 35.23)).toBe(false);
    expect(approxEqual(1, 1.02)).toBe(true);
    expect(approxEqual(1, 1.03)).toBe(false);
  });

  it('ist gegen fehlende Werte robust', () => {
    expect(approxEqual(null, 1)).toBe(false);
    expect(approxEqual(1, undefined)).toBe(false);
  });
});
