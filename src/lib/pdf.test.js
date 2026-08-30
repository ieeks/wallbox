import { describe, it, expect } from 'vitest';
import { itemsToLines } from './pdf.js';

// pdf.js-Textitem nachbilden: transform[4] = x, transform[5] = y.
const item = (str, x, y, width, height = 8) => ({
  str, width, height, transform: [height, 0, 0, height, x, y],
});

describe('itemsToLines', () => {
  it('sortiert Zeilen von oben nach unten (PDF-Ursprung ist unten links)', () => {
    const lines = itemsToLines([
      item('unten', 0, 100, 30),
      item('oben', 0, 300, 30),
      item('mitte', 0, 200, 30),
    ]);
    expect(lines).toEqual(['oben', 'mitte', 'unten']);
  });

  it('bündelt Fragmente mit leicht abweichendem Y in dieselbe Zeile', () => {
    const lines = itemsToLines([item('A', 0, 200, 10), item('B', 20, 201.4, 10)]);
    expect(lines).toHaveLength(1);
  });

  it('trennt Spalten mit Tab und Wörter mit Leerzeichen', () => {
    // Lücke > 1.2 × Schrifthöhe → Spalte; kleinere Lücke → Wortabstand.
    const lines = itemsToLines([
      item('Teilsumme', 0, 100, 40),
      item('9.50', 200, 100, 20),
    ]);
    expect(lines[0]).toBe('Teilsumme\t9.50');

    const wort = itemsToLines([
      item('Preis', 0, 100, 20),
      item('EUR', 23, 100, 15),
    ]);
    expect(wort[0]).toBe('Preis EUR');
  });

  it('klebt Fragmente ohne Lücke zusammen', () => {
    const lines = itemsToLines([item('Strom', 0, 100, 25), item('gebühr', 25, 100, 25)]);
    expect(lines[0]).toBe('Stromgebühr');
  });

  it('überspringt leere Fragmente und liefert keine leeren Zeilen', () => {
    const lines = itemsToLines([item('  ', 0, 100, 5), item('', 10, 100, 0), item('X', 0, 50, 5)]);
    expect(lines).toEqual(['X']);
  });

  it('verkraftet eine leere Eingabe', () => {
    expect(itemsToLines([])).toEqual([]);
    expect(itemsToLines(undefined)).toEqual([]);
  });
});
