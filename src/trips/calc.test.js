import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseInvoiceText } from '../parsers/index.js';
import { aggregateTrip, fuelComparison, estimateKm, referenceConsumption, splitAggregate, outsideWindow } from './calc.js';
import { suggestLeg, fromHomeCharge, fromInvoiceCharge, effectiveKwh, estimateKwhFromMinutes } from './model.js';

const fixture = name =>
  readFileSync(fileURLToPath(new URL(`../../fixtures/${name}.txt`, import.meta.url)), 'utf8');

const parseFixture = name => parseInvoiceText(fixture(name), { fileName: `${name}.pdf` }).charges;

describe('suggestLeg', () => {
  const trip = { dateStart: '2026-07-10', dateEnd: '2026-07-14' };

  it('ordnet nach dem Ladedatum zu', () => {
    expect(suggestLeg('2026-07-10', trip)).toBe('outbound');
    expect(suggestLeg('2026-07-12', trip)).toBe('onsite');
    expect(suggestLeg('2026-07-14', trip)).toBe('return');
  });

  it('zählt die Heimladung am Vorabend zur Hinfahrt', () => {
    // Typisch ist eine Ladung am Abend vor der Abfahrt – die gehört zur
    // Hinfahrt, nicht in ein eigenes Fach.
    expect(suggestLeg('2026-07-09', trip)).toBe('outbound');
  });
});

describe('effectiveKwh', () => {
  it('nimmt die gemessene Menge, wenn es eine gibt', () => {
    expect(effectiveKwh({ kwh: 26.707, kwhEstimate: 99 })).toBe(26.707);
  });

  it('fällt beim Minutentarif auf die Schätzung zurück', () => {
    expect(effectiveKwh({ kwh: null, kwhEstimate: 18 })).toBe(18);
  });

  it('bleibt null, wenn beides fehlt – nicht 0', () => {
    expect(effectiveKwh({ kwh: null })).toBeNull();
  });

  it('schätzt aus Minuten und Ø-Leistung', () => {
    // 12 min bei 90 kW ≈ 18 kWh – der Wert aus dem Referenz-Report.
    expect(estimateKwhFromMinutes(12)).toBe(18);
    expect(estimateKwhFromMinutes(0)).toBeNull();
  });
});

describe('fuelComparison', () => {
  const v = fuelComparison({
    km: 1172, costTotal: 106.44, litersPer100Min: 9.0, litersPer100Max: 9.5, fuelPrice: 1.76,
  });

  it('gibt eine Spanne aus, keinen Punktwert', () => {
    // Der Verbrauch eines Verbrenners auf der Langstrecke ist geschätzt.
    expect(v.literMin).toBeCloseTo(105.5, 0);
    expect(v.literMax).toBeCloseTo(111.3, 0);
    expect(v.costMin).toBeGreaterThan(180);
    expect(v.costMax).toBeGreaterThan(v.costMin);
    expect(v.estimated).toBe(true);
  });

  it('rechnet die Ersparnis als Spanne gegen die echten Ladekosten', () => {
    // Referenz-Report: ~€80–90 Ersparnis, €9,08/100km statt ~€16,00/100km.
    expect(v.savingMin).toBeGreaterThan(75);
    expect(v.savingMax).toBeLessThan(95);
    expect(v.evPer100).toBeCloseTo(9.08, 1);
  });

  it('dreht eine verkehrt herum eingegebene Spanne um', () => {
    const w = fuelComparison({ km: 100, costTotal: 10, litersPer100Min: 9.5, litersPer100Max: 9.0, fuelPrice: 1.8 });
    expect(w.litersPer100Min).toBe(9);
    expect(w.litersPer100Max).toBe(9.5);
  });

  it('gibt null ohne Kilometer oder Preis', () => {
    expect(fuelComparison({ km: 0, costTotal: 10, litersPer100Min: 9, litersPer100Max: 9.5, fuelPrice: 1.8 })).toBeNull();
    expect(fuelComparison({ km: 100, costTotal: 10, litersPer100Min: 9, litersPer100Max: 9.5, fuelPrice: 0 })).toBeNull();
  });
});

describe('Kilometer-Rückrechnung (Edge Case 6)', () => {
  it('mittelt den Verbrauch der bisherigen Trips', () => {
    expect(referenceConsumption([{ consumption: 22.5 }, { consumption: 22.8 }])).toBe(22.65);
    expect(referenceConsumption([])).toBeNull();
    expect(referenceConsumption([{ consumption: null }])).toBeNull();
  });

  it('rechnet km hoch und gibt ein Plausibilitätsband von ±5 %', () => {
    const e = estimateKm(264.09, 22.5);
    expect(e.km).toBe(1174);
    expect(e.low).toBe(1115);
    expect(e.high).toBe(1232);
    expect(e.estimated).toBe(true);
  });

  it('schätzt nicht ohne Referenz', () => {
    expect(estimateKm(264, null)).toBeNull();
  });
});

describe('outsideWindow (Edge Case 8)', () => {
  const trip = { dateStart: '2026-07-10', dateEnd: '2026-07-14' };

  it('lässt einen Tag Luft an beiden Enden', () => {
    // Die Heimladung am Vorabend ist normal, kein Ausreisser.
    expect(outsideWindow('2026-07-09', trip)).toBe(false);
    expect(outsideWindow('2026-07-15', trip)).toBe(false);
  });

  it('erkennt echte Ausreisser', () => {
    expect(outsideWindow('2026-07-01', trip)).toBe(true);
    expect(outsideWindow('2026-08-20', trip)).toBe(true);
  });
});

describe('splitAggregate (Edge Cases 2 und 3)', () => {
  const [aggregat] = parseFixture('ewe-go-sammelrechnung');

  it('rechnet die kWh über den €/kWh-Satz der Sammelrechnung zurück', () => {
    // Die beiden Sessions aus der EWE-Go-App: Markdorf 32,00 €, Olching 38,08 €.
    const r = splitAggregate(aggregat, [
      { date: '2026-04-12', location: 'Markdorf, Planckstr.', grossTotal: 32.00 },
      { date: '2026-04-13', location: 'Olching', grossTotal: 38.08 },
    ]);
    expect(r.charges).toHaveLength(2);
    expect(r.charges[0].kwh).toBeCloseTo(61.5, 1);
    expect(r.charges[1].kwh).toBeCloseTo(73.2, 1);
    expect(r.rate).toBeCloseTo(0.520, 3);
  });

  it('markiert die zurückgerechneten Mengen als geschätzt', () => {
    const r = splitAggregate(aggregat, [{ date: '2026-04-12', grossTotal: 32.00 }]);
    expect(r.charges[0].estimated).toBe(true);
    expect(r.charges[0].isAggregate).toBe(false);
    expect(r.charges[0].splitFrom).toBe(aggregat.id);
  });

  it('meldet die Prüfsumme, wenn die Rechnung vollständig aufgeteilt ist', () => {
    const r = splitAggregate(aggregat, [
      { date: '2026-04-12', grossTotal: 32.00 },
      { date: '2026-04-13', grossTotal: 38.08 },
    ]);
    expect(r.sumSplits).toBe(70.08);
    expect(r.invoiceTotal).toBe(70.07);
    expect(r.complete).toBe(true);
  });

  it('erlaubt eine unvollständige Aufteilung – Fremdladungen bleiben draussen', () => {
    // Edge Case 3: eine Monatsrechnung enthält Ladungen ausserhalb des Trips.
    // Die dürfen weggelassen werden, ohne dass es als Fehler gilt.
    const r = splitAggregate(aggregat, [{ date: '2026-04-12', grossTotal: 32.00 }]);
    expect(r.complete).toBe(false);
    expect(r.difference).toBe(-38.07);
    expect(r.charges).toHaveLength(1);
  });
});

describe('Warnungen', () => {
  const trip = { dateStart: '2026-07-10', dateEnd: '2026-07-14', km: 1172 };
  const texte = charges => aggregateTrip({ trip, charges }).warnings.map(w => w.text).join(' | ');

  it('warnt, wenn keine Heimladung dabei ist (Spec §5)', () => {
    expect(texte(parseFixture('ionity-it-bagnaria-arsa').map(c => fromInvoiceCharge(c, trip))))
      .toMatch(/Keine Heimladung/);
  });

  it('warnt vor einer noch nicht aufgeteilten Sammelrechnung', () => {
    expect(texte(parseFixture('ewe-go-sammelrechnung').map(c => fromInvoiceCharge(c, trip))))
      .toMatch(/Sammelrechnung/);
  });

  it('weist auf geschätzte Mengen hin', () => {
    expect(texte(parseFixture('tesla-at-stpoelten-minutentarif').map(c => fromInvoiceCharge(c, trip))))
      .toMatch(/Minutentarif/);
  });
});

// =====================================================================
// Integrationstest Spec §10: ein kompletter Trip.
// =====================================================================
// Drei Positionen kommen aus echten Rechnungs-Fixtures. Die Heimladung und
// die beiden Völkermarkt-Stopps liegen als Werte vor (Heimladung aus dem
// Ladefuchs-Bestand, Völkermarkt aus dem Referenz-Report) – für die beiden
// Tesla-AT-Rechnungen gibt es noch keine PDFs.
describe('Trip Caorle – Gesamtrechnung', () => {
  const trip = {
    id: 'caorle-2026-07',
    title: 'Wien ↔ Caorle',
    dateStart: '2026-07-10',
    dateEnd: '2026-07-14',
    km: 1172,
  };

  const heimladung = fromHomeCharge(
    { id: 'home-1', date: '2026-07-09', time: '21:53', kwh: 46.555, total: 10.67, bruttoPerKwh: 0.2292, dauer: '6:34:00' },
    trip,
  );

  const voelkermarkt = (date, kwh, grossTotal) => fromInvoiceCharge({
    id: `tesla-at:x:${date}:${kwh}`, provider: 'tesla-at', date, location: 'Völkermarkt',
    kwh, grossTotal, netTotal: null, grossPerKwh: grossTotal / kwh, vatRate: 0.2,
    estimated: false, isAggregate: false, needsReview: false, reviewReasons: [],
  }, trip);

  const charges = [
    heimladung,
    voelkermarkt('2026-07-10', 64.2622, 21.20),
    ...parseFixture('ionity-it-bagnaria-arsa').map(c => fromInvoiceCharge(c, trip)),
    ...parseFixture('tesla-it-noventa-di-piave').map(c => fromInvoiceCharge(c, trip)),
    voelkermarkt('2026-07-14', 68.5208, 22.61),
    ...parseFixture('electra-at-villach').map(c => fromInvoiceCharge(c, trip)),
  ];

  const r = aggregateTrip({
    trip, charges, fuelPrice: 1.76, litersPer100Min: 9.0, litersPer100Max: 9.5,
  });

  it('trifft die Sollwerte aus §10', () => {
    expect(r.kwhTotal).toBeCloseTo(264.09, 1);
    expect(r.costTotal).toBe(106.44);
    expect(r.consumption).toBeCloseTo(22.5, 1);
  });

  it('rechnet Ø-Preis und Kosten je 100 km', () => {
    // Referenz-Report: Ø €0,403/kWh, €9,08/100km.
    expect(r.avgPrice).toBeCloseTo(0.403, 3);
    expect(r.costPer100).toBeCloseTo(9.08, 2);
  });

  it('splittet Hin- und Rückfahrt', () => {
    // Hinfahrt: daheim + Völkermarkt + Bagnaria Arsa = 137,53 kWh / €53,33.
    expect(r.legs.outbound.count).toBe(3);
    expect(r.legs.outbound.kwh).toBeCloseTo(137.53, 1);
    expect(r.legs.outbound.cost).toBe(53.33);
    // Rückfahrt: Noventa + Völkermarkt + Villach = 126,56 kWh / €53,11.
    expect(r.legs.return.count).toBe(3);
    expect(r.legs.return.kwh).toBeCloseTo(126.56, 1);
    expect(r.legs.return.cost).toBe(53.11);
  });

  it('weist die Heimladung als günstigsten Strom aus', () => {
    expect(r.homeCount).toBe(1);
    expect(r.homeCost).toBe(10.67);
    const preise = r.charges.filter(c => c.grossPerKwh).map(c => c.grossPerKwh);
    expect(Math.min(...preise)).toBeCloseTo(0.2292, 3);
  });

  it('vergleicht mit dem Verbrenner als Spanne', () => {
    // Referenz-Report: €186–196 Benzinkosten, ~€80–90 Ersparnis.
    expect(r.fuel.costMin).toBeCloseTo(185.6, 0);
    expect(r.fuel.costMax).toBeCloseTo(195.9, 0);
    expect(r.fuel.savingMin).toBeCloseTo(79.2, 0);
    expect(r.fuel.savingMax).toBeCloseTo(89.5, 0);
  });

  it('meldet keine offenen Punkte für diesen Trip', () => {
    // Heimladung vorhanden, km eingetragen, keine Sammelrechnung, keine
    // Schätzwerte – der Report steht ohne Vorbehalt.
    expect(r.warnings).toEqual([]);
  });
});
