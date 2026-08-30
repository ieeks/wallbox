import { describe, it, expect, beforeEach } from 'vitest';
import { setImportReport, renderImportReport } from './ui.js';

const trip = { id: 'caorle-2026-07' };

describe('Unerkannt-Bereich (Spec §4)', () => {
  beforeEach(() => setImportReport(null));

  it('zeigt nichts an, solange kein Import gelaufen ist', () => {
    expect(renderImportReport(trip)).toBe('');
  });

  it('gehört zum Trip, für den importiert wurde', () => {
    // Sonst stünde der Bericht eines Trips unter einem anderen.
    setImportReport({ tripId: 'anderer-trip', imported: 2, duplicates: 0, failed: [] });
    expect(renderImportReport(trip)).toBe('');
  });

  it('meldet übernommene Ladungen und übersprungene Duplikate', () => {
    setImportReport({ tripId: trip.id, imported: 3, duplicates: 1, failed: [] });
    const html = renderImportReport(trip);
    expect(html).toMatch(/3 Ladungen übernommen/);
    expect(html).toMatch(/1 Duplikat übersprungen/);
  });

  // Kein Parser-Treffer heisst nicht „verloren": laut Spec §4 bekommt die
  // Datei einen eigenen Bereich mit Eingabemaske. Ohne den käme eine
  // Rechnung von einem unbekannten Anbieter gar nicht in den Trip.
  it('bietet für jede unerkannte Datei einen Knopf zum Eintragen', () => {
    setImportReport({
      tripId: trip.id,
      imported: 1,
      duplicates: 0,
      failed: [
        { fileName: 'fremd.pdf', reason: 'Format nicht erkannt' },
        { fileName: 'scan.pdf', reason: 'Dieses PDF enthält keine Textebene' },
      ],
    });
    const html = renderImportReport(trip);
    expect(html).toMatch(/2 Dateien nicht erkannt/);
    expect(html).toMatch(/fremd\.pdf/);
    expect(html).toMatch(/keine Textebene/);
    expect(html).toMatch(/tripAddCharge\('caorle-2026-07', 0\)/);
    expect(html).toMatch(/tripAddCharge\('caorle-2026-07', 1\)/);
  });

  it('maskiert Dateinamen, die wie HTML aussehen', () => {
    setImportReport({
      tripId: trip.id, imported: 0, duplicates: 0,
      failed: [{ fileName: '<img src=x onerror=alert(1)>.pdf', reason: 'Format nicht erkannt' }],
    });
    const html = renderImportReport(trip);
    expect(html).not.toMatch(/<img/);
    expect(html).toMatch(/&lt;img/);
  });
});
