// =====================================================================
// TRIP-AGGREGATION (Spec §6)
// =====================================================================
// Reine Rechnung, keine Globals: alles kommt als Argument herein, damit die
// Logik ohne Browser testbar bleibt. Die Anbindung an `charges`, `settings`
// und `benzinPreis()` des Ladefuchs passiert in index.js.
// =====================================================================
import { round } from '../lib/num.js';
import { LEGS, effectiveKwh, isEstimatedKwh } from './model.js';

// Plausibilitätsband für eine hochgerechnete Kilometerleistung (Spec §6).
const KM_BAND = 0.05;

function sum(list, pick) {
  return list.reduce((s, x) => s + (pick(x) ?? 0), 0);
}

// =====================================================================
// Verbrenner-Vergleich. Bewusst als SPANNE: der Verbrauch eines Verbrenners
// auf der Langstrecke ist eine Schätzung, kein Messwert – ein Punktwert
// würde eine Genauigkeit vortäuschen, die es nicht gibt.
// =====================================================================
export function fuelComparison({ km, costTotal, litersPer100Min, litersPer100Max, fuelPrice }) {
  if (!(km > 0) || !(fuelPrice > 0)) return null;

  const min = Math.min(litersPer100Min, litersPer100Max);
  const max = Math.max(litersPer100Min, litersPer100Max);

  const literMin = km / 100 * min;
  const literMax = km / 100 * max;
  const costMin = literMin * fuelPrice;
  const costMax = literMax * fuelPrice;

  return {
    litersPer100Min: min,
    litersPer100Max: max,
    literMin: round(literMin, 1),
    literMax: round(literMax, 1),
    costMin: round(costMin, 2),
    costMax: round(costMax, 2),
    savingMin: round(costMin - costTotal, 2),
    savingMax: round(costMax - costTotal, 2),
    evPer100: round(costTotal / km * 100, 2),
    fuelPer100Min: round(costMin / km * 100, 2),
    fuelPer100Max: round(costMax / km * 100, 2),
    estimated: true,
  };
}

// =====================================================================
// Kilometer zurückrechnen, wenn keine eingetragen sind (Edge Case 6).
// Referenz ist der Ø-Verbrauch der bisherigen Trips – nicht der Wert aus
// den Einstellungen, denn der beschreibt den Alltag, nicht die Langstrecke.
// =====================================================================
export function referenceConsumption(previousTrips = []) {
  const werte = previousTrips
    .map(t => t.consumption)
    .filter(v => typeof v === 'number' && v > 0);
  if (werte.length === 0) return null;
  return round(werte.reduce((a, b) => a + b, 0) / werte.length, 2);
}

export function estimateKm(kwhTotal, refConsumption) {
  if (!(kwhTotal > 0) || !(refConsumption > 0)) return null;
  const km = kwhTotal / refConsumption * 100;
  return {
    km: Math.round(km),
    low: Math.round(km * (1 - KM_BAND)),
    high: Math.round(km * (1 + KM_BAND)),
    estimated: true,
  };
}

// =====================================================================
// Hauptrechnung
// =====================================================================
export function aggregateTrip({
  trip,
  charges,                 // bereits normalisiert (model.js)
  fuelPrice = null,
  litersPer100Min = null,
  litersPer100Max = null,
  previousTrips = [],
}) {
  const sorted = [...charges].sort((a, b) =>
    (a.date || '').localeCompare(b.date || '') || (a.time || '').localeCompare(b.time || ''));

  const kwhTotal = round(sum(sorted, c => effectiveKwh(c)), 4);
  const costTotal = round(sum(sorted, c => c.grossTotal), 2);

  // Kilometer: Handeingabe schlägt Hochrechnung.
  let km = typeof trip.km === 'number' && trip.km > 0 ? trip.km : null;
  let kmEstimated = false;
  let kmBand = null;
  if (km === null) {
    const geschaetzt = estimateKm(kwhTotal, referenceConsumption(previousTrips));
    if (geschaetzt) {
      km = geschaetzt.km;
      kmEstimated = true;
      kmBand = { low: geschaetzt.low, high: geschaetzt.high };
    }
  }

  const consumption = km > 0 && kwhTotal > 0 ? round(kwhTotal / km * 100, 1) : null;
  const avgPrice = kwhTotal > 0 ? round(costTotal / kwhTotal, 4) : null;
  const costPer100 = km > 0 ? round(costTotal / km * 100, 2) : null;

  const legs = {};
  for (const leg of LEGS) {
    const teil = sorted.filter(c => c.leg === leg);
    legs[leg] = {
      leg,
      count: teil.length,
      kwh: round(sum(teil, c => effectiveKwh(c)), 3),
      cost: round(sum(teil, c => c.grossTotal), 2),
      hasEstimates: teil.some(isEstimatedKwh),
    };
  }

  const homeCharges = sorted.filter(c => c.isHome);
  const fuel = fuelComparison({
    km, costTotal, litersPer100Min, litersPer100Max, fuelPrice,
  });

  return {
    charges: sorted,
    count: sorted.length,
    kwhTotal,
    costTotal,
    km,
    kmEstimated,
    kmBand,
    consumption,
    avgPrice,
    costPer100,
    legs,
    homeCount: homeCharges.length,
    homeKwh: round(sum(homeCharges, c => effectiveKwh(c)), 3),
    homeCost: round(sum(homeCharges, c => c.grossTotal), 2),
    hasEstimates: sorted.some(isEstimatedKwh),
    fuel,
    warnings: tripWarnings({ trip, charges: sorted, kmEstimated }),
  };
}

// =====================================================================
// Was am Report nicht stimmen kann – lieber sichtbar als still.
// =====================================================================
export function tripWarnings({ trip, charges, kmEstimated }) {
  const w = [];

  // Spec §5: der häufigste Fehler in den bisherigen Auswertungen von Hand.
  // Ohne die Ladung am Vorabend ist der Verbrauch systematisch zu niedrig.
  if (!charges.some(c => c.isHome)) {
    w.push({
      level: 'warn',
      text: 'Keine Heimladung im Trip. Ohne die Ladung vor der Abfahrt fällt der '
        + 'Verbrauch systematisch zu niedrig aus.',
    });
  }

  // Edge Case 3: eine Monatsrechnung enthält regelmässig Fremdladungen.
  const aggregate = charges.filter(c => c.isAggregate);
  if (aggregate.length > 0) {
    w.push({
      level: 'warn',
      text: `${aggregate.length} Sammelrechnung${aggregate.length > 1 ? 'en' : ''} noch nicht aufgeteilt – `
        + 'die volle Monatsmenge zählt derzeit mit, auch Ladungen ausserhalb der Reise.',
    });
  }

  // Edge Case 8: Rechnung ausserhalb des Zeitraums.
  const draussen = charges.filter(c => outsideWindow(c.date, trip));
  if (draussen.length > 0) {
    w.push({
      level: 'info',
      text: `${draussen.length} Ladung${draussen.length > 1 ? 'en liegen' : ' liegt'} ausserhalb des Reisezeitraums.`,
    });
  }

  const zuPruefen = charges.filter(c => c.needsReview);
  if (zuPruefen.length > 0) {
    w.push({
      level: 'warn',
      text: `${zuPruefen.length} Ladung${zuPruefen.length > 1 ? 'en' : ''} konnte${zuPruefen.length > 1 ? 'n' : ''} `
        + 'nicht eindeutig gelesen werden – bitte Beträge prüfen.',
    });
  }

  if (kmEstimated) {
    w.push({
      level: 'info',
      text: 'Kilometer sind aus dem Verbrauch hochgerechnet, nicht eingetragen.',
    });
  }

  const geschaetzt = charges.filter(isEstimatedKwh);
  if (geschaetzt.length > 0) {
    w.push({
      level: 'info',
      text: `${geschaetzt.length} Ladung${geschaetzt.length > 1 ? 'en ohne' : ' ohne'} kWh-Angabe auf der Rechnung `
        + '(Minutentarif) – die Menge ist geschätzt.',
    });
  }

  return w;
}

// Ein Tag Luft an beiden Enden: die Heimladung am Vorabend und ein später
// abgerechneter Rückfahrt-Stopp sind normal, keine Ausreisser.
export function outsideWindow(date, trip, toleranceDays = 1) {
  if (!date || !trip.dateStart || !trip.dateEnd) return false;
  const shift = (iso, days) => {
    const d = new Date(iso + 'T12:00:00');
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  };
  return date < shift(trip.dateStart, -toleranceDays) || date > shift(trip.dateEnd, toleranceDays);
}

// =====================================================================
// Sammelrechnung aufteilen (Spec §4.2, Edge Cases 2 und 3)
// =====================================================================
// Eingabe sind die Einzelsessions aus der Anbieter-App (Datum, Ort, Betrag).
// Die kWh werden über den €/kWh-Satz der Sammelrechnung zurückgerechnet.
// Die Prüfsumme vergleicht bewusst gegen die SUMME DER EINGEGEBENEN Sessions,
// nicht gegen den Rechnungsbetrag: Ladungen ausserhalb des Trips sollen
// bewusst weggelassen werden können.
export function splitAggregate(aggregateCharge, splits, { tolerance = 0.05 } = {}) {
  const rate = aggregateCharge.grossPerKwh;
  const sumSplits = round(sum(splits, s => s.grossTotal), 2);
  const complete = Math.abs(sumSplits - (aggregateCharge.grossTotal ?? 0)) <= tolerance;

  const charges = splits.map((s, i) => ({
    id: `${aggregateCharge.id}#${i + 1}`,
    provider: aggregateCharge.provider,
    date: s.date,
    location: s.location || null,
    kwh: rate > 0 && s.grossTotal > 0 ? round(s.grossTotal / rate, 3) : null,
    grossTotal: round(s.grossTotal, 2),
    netTotal: null,
    grossPerKwh: rate ?? null,
    vatRate: aggregateCharge.vatRate ?? null,
    leg: s.leg || aggregateCharge.leg || 'onsite',
    // Die kWh sind zurückgerechnet, nicht gemessen.
    estimated: true,
    isAggregate: false,
    isHome: false,
    needsReview: false,
    reviewReasons: [],
    splitFrom: aggregateCharge.id,
    invoiceNumber: aggregateCharge.invoiceNumber ?? null,
  }));

  return {
    charges,
    sumSplits,
    invoiceTotal: aggregateCharge.grossTotal ?? null,
    difference: round(sumSplits - (aggregateCharge.grossTotal ?? 0), 2),
    // „complete" heisst: die Sammelrechnung ist vollständig zugeordnet.
    // Nicht vollständig ist ausdrücklich erlaubt – dann enthielt der Monat
    // Ladungen ausserhalb der Reise.
    complete,
    rate,
  };
}
