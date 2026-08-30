import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { detectParser, parseInvoiceText, dedupeCharges, PARSERS } from './index.js';

const fixture = name =>
  readFileSync(fileURLToPath(new URL(`../../fixtures/${name}.txt`, import.meta.url)), 'utf8');

describe('detectParser', () => {
  it('findet den Tesla-Parser', () => {
    expect(detectParser(fixture('tesla-de-lindau')).id).toBe('tesla');
  });

  it('gibt null bei unbekanntem Format zurück', () => {
    expect(detectParser('Irgendeine Rechnung ohne bekannte Merkmale')).toBeNull();
    expect(detectParser('')).toBeNull();
    expect(detectParser(null)).toBeNull();
  });

  it('lässt einen abstürzenden Parser den Durchlauf nicht abbrechen', () => {
    const kaputt = { id: 'kaputt', label: 'Kaputt', detect() { throw new Error('boom'); }, parse: () => [] };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(detectParser(fixture('tesla-de-lindau'), [kaputt, ...PARSERS]).id).toBe('tesla');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('parseInvoiceText', () => {
  it('reicht den Dateinamen an jede Charge durch', () => {
    const r = parseInvoiceText(fixture('tesla-de-lindau'), { fileName: 'lindau.pdf' });
    expect(r.parserId).toBe('tesla');
    expect(r.unrecognized).toBe(false);
    expect(r.charges[0].sourceFile).toBe('lindau.pdf');
  });

  it('meldet unerkannte Formate, ohne zu werfen', () => {
    const r = parseInvoiceText('Rechnung von irgendwem', { fileName: 'fremd.pdf' });
    expect(r.unrecognized).toBe(true);
    expect(r.charges).toEqual([]);
    expect(r.error).toBeNull();
    expect(r.fileName).toBe('fremd.pdf');
  });

  it('fängt einen werfenden Parser ab', () => {
    const kaputt = { id: 'k', label: 'K', detect: () => true, parse() { throw new Error('kaputt'); } };
    const r = parseInvoiceText('egal', { parsers: [kaputt] });
    expect(r.unrecognized).toBe(true);
    expect(r.error).toMatch(/kaputt/);
  });

  it('meldet eine erkannte Rechnung ohne Positionen als prüfbedürftig', () => {
    const r = parseInvoiceText('Tesla Germany GmbH\nStromgebühr ohne Tabelle');
    expect(r.parserId).toBe('tesla');
    expect(r.unrecognized).toBe(true);
    expect(r.error).toMatch(/keine Ladeposition/);
  });
});

// Edge Case 7: dieselbe Rechnung ein zweites Mal in die Drop-Zone gezogen
// darf den Trip nicht doppelt belasten.
describe('dedupeCharges', () => {
  it('wirft eine doppelt eingelesene Rechnung weg, auch unter anderem Dateinamen', () => {
    const a = parseInvoiceText(fixture('tesla-de-lindau'), { fileName: 'lindau.pdf' }).charges;
    const b = parseInvoiceText(fixture('tesla-de-lindau'), { fileName: 'lindau-kopie.pdf' }).charges;
    expect(dedupeCharges([...a, ...b])).toHaveLength(1);
  });

  it('behält zwei echte Ladungen desselben Tages', () => {
    // Irschenberg und Lindau sind beide vom 10.04.2026.
    const a = parseInvoiceText(fixture('tesla-de-lindau')).charges;
    const b = parseInvoiceText(fixture('tesla-de-irschenberg')).charges;
    expect(a[0].date).toBe(b[0].date);
    expect(dedupeCharges([...a, ...b])).toHaveLength(2);
  });
});
