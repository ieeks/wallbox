// =====================================================================
// EWE GO – MONATS-SAMMELRECHNUNG
// =====================================================================
// Anders als bei allen anderen Anbietern ist das KEINE Rechnung je Ladung,
// sondern eine Zeile über einen ganzen Leistungszeitraum:
//
//   Ladetarif - EWE Go (in kWh) ⇥ 134,756 ⇥ 0,436975 ⇥ 19 ⇥ 11,19 ⇥ 58,88
//   01.04.2026 bis
//   30.04.2026
//
// Daraus lässt sich nicht ableiten, welche Ladung wann und wo war – und eine
// Monatsrechnung enthält regelmässig Ladungen, die gar nicht zum Trip gehören
// (Edge Case 3). Deshalb entsteht hier genau EINE Charge mit
// `isAggregate: true`. Das Aufteilen passiert im UI: die Einzelsessions aus
// der EWE-Go-App eingeben, das Tool rechnet die kWh über den €/kWh-Satz
// dieser Rechnung zurück.
//
// `grossPerKwh` ist deshalb hier nicht nur Anzeige, sondern der Umrechnungs-
// satz für die Aufteilung.
// =====================================================================
import { parseDecimal, decimalsOf, round } from '../lib/num.js';
import { classifyUnitPrice } from './verify.js';
import { buildCharge, toIsoDate } from './charge.js';

const TARIFF_ROW = /^Ladetarif\b/i;

const cells = line => line.split('\t').map(c => c.trim());

function parse(text) {
  const lines = text.split('\n').filter(Boolean);

  // Kopfzeile mit Spaltennamen, Werte stehen in der Folgezeile.
  let invoiceNumber = null;
  let invoiceDate = null;
  const headIdx = lines.findIndex(l => /Rechnungsnummer/i.test(l) && /Rechnungsdatum/i.test(l));
  if (headIdx !== -1 && lines[headIdx + 1]) {
    const keys = cells(lines[headIdx]);
    const vals = cells(lines[headIdx + 1]);
    const at = name => {
      const i = keys.findIndex(k => new RegExp(name, 'i').test(k));
      return i === -1 ? null : vals[i];
    };
    invoiceNumber = at('Rechnungsnummer');
    invoiceDate = toIsoDate(at('Rechnungsdatum') || '');
  }

  const rowIdx = lines.findIndex(l => TARIFF_ROW.test(l));
  if (rowIdx === -1) return [];
  const c = cells(lines[rowIdx]);

  // Bezeichnung ⇥ Menge ⇥ Stückpreis ⇥ Steuer % ⇥ Steuer ⇥ Netto
  const kwh = parseDecimal(c[1] || '');
  const unitPriceRaw = c[2] || '';
  const unitPrice = parseDecimal(unitPriceRaw);
  const vatPct = parseDecimal(c[3] || '');
  const netTotal = parseDecimal(c[5] || '');

  const grossTotal = parseDecimal(
    (lines.find(l => /^Gesamtbetrag EUR\b/i.test(l)) || '').split('\t').pop() || ''
  ) ?? (typeof netTotal === 'number' && typeof vatPct === 'number'
    ? round(netTotal * (1 + vatPct / 100), 2)
    : null);

  // Leistungszeitraum steht in den Zeilen unter der Position („01.04.2026 bis" /
  // „30.04.2026"), manchmal auch zusammen auf einer.
  const zeitraumText = [lines[rowIdx], lines[rowIdx + 1], lines[rowIdx + 2]].filter(Boolean).join(' ');
  const daten = zeitraumText.match(/\d{2}\.\d{2}\.\d{4}/g) || [];
  const periodStart = daten[0] ? toIsoDate(daten[0]) : null;
  const periodEnd = daten[1] ? toIsoDate(daten[1]) : null;

  const basis = classifyUnitPrice({
    unitPrice, quantity: kwh, netTotal, grossTotal,
    unitPriceDecimals: decimalsOf(unitPriceRaw),
  });

  const review = [];
  if (basis === 'unknown') review.push('Preis × Menge trifft weder Netto- noch Bruttobetrag');
  if (typeof kwh !== 'number') review.push('Keine kWh-Menge gefunden');

  return [buildCharge({
    provider: 'ewe-go',
    id: `ewe-go:${invoiceNumber || 'ohne-nr'}:${periodStart || invoiceDate}`,
    date: periodStart || invoiceDate,
    location: null,
    kwh,
    grossTotal,
    netTotal,
    vatRate: typeof vatPct === 'number' ? round(vatPct / 100, 4) : null,
    unitPriceBasis: basis,
    isAggregate: true,
    periodStart,
    periodEnd,
    invoiceNumber,
    invoiceDate,
    reviewReasons: review,
    raw: { row: c, unitPrice },
  })];
}

export default {
  id: 'ewe-go',
  label: 'EWE Go (Sammelrechnung)',
  detect: text => /EWE\s*Go/i.test(text) && /Ladetarif/i.test(text),
  parse,
};
