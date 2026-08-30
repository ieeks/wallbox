// =====================================================================
// IONITY (italienische Niederlassung, Rechnung auf Italienisch)
// =====================================================================
// Positionszeile:
//   Bagnaria Arsa 10/07/2026: 0.80 EUR/KWH ⇥ 26,707 KWH ⇥ 3,87 EUR (22,00 %) ⇥ 17,59 EUR
//
// Zwei Eigenheiten:
//
// 1. Dezimaltrenner-Mix in EINER Zeile (Edge Case 10): Punkt beim kWh-Preis,
//    Komma bei Menge und Beträgen. Deshalb `parseDecimal()` je Feld statt
//    eines Dateiformats.
// 2. Der Betrag der Positionszeile ist NETTO (17,59), die Steuer steht
//    daneben (3,87). Brutto ist die Summe – nicht netto × (1+Satz), damit
//    die Cent-Rundung der Rechnung erhalten bleibt.
//
// Der ausgewiesene Stückpreis ist auf zwei Stellen gerundet: 0.80 × 26,707 =
// 21,37, tatsächlich abgerechnet sind 21,46. Die Prüfung in verify.js fängt
// das über die mengenabhängige Toleranz ab.
// =====================================================================
import { parseDecimal, decimalsOf, round } from '../lib/num.js';
import { classifyUnitPrice } from './verify.js';
import { buildCharge, toIsoDate } from './charge.js';

const ROW = /^(.*?)\s+(\d{2}[./]\d{2}[./]\d{4}):\s*([\d.,]+)\s*EUR\s*\/\s*KWH/i;

const cells = line => line.split('\t').map(c => c.trim());

function field(text, ...labels) {
  for (const label of labels) {
    const m = text.match(new RegExp(`${label}\\s*:?\\s*(?:\\t|\\s)\\s*([^\\t\\n]+)`, 'i'));
    if (m) return m[1].trim();
  }
  return null;
}

function parse(text) {
  const lines = text.split('\n').filter(Boolean);

  const invoiceNumber = field(text, 'Numero di fattura', 'Rechnungsnummer', 'Invoice number');
  const invoiceDate = toIsoDate(field(text, 'Data della fattura', 'Rechnungsdatum', 'Invoice date') || '');
  const invoiceTotal = parseDecimal(
    field(text, 'Importo totale della fattura', 'Rechnungsbetrag', 'Total invoice amount') || ''
  );

  const charges = [];

  for (const line of lines) {
    if (!/EUR\s*\/\s*KWH/i.test(line)) continue;
    const c = cells(line);
    const head = c[0].match(ROW);
    if (!head) continue;

    const location = head[1].trim() || null;
    const date = toIsoDate(head[2]);
    const unitPriceRaw = head[3];
    const unitPrice = parseDecimal(unitPriceRaw);

    const quantity = parseDecimal(c[1] || '');
    const vatCell = c[2] || '';
    const vatAmount = parseDecimal(vatCell);
    const vatPct = parseDecimal((vatCell.match(/\(([^)]*)\)/) || [])[1] || '');
    const netTotal = parseDecimal(c[3] || '');

    if (typeof netTotal !== 'number' || typeof quantity !== 'number') continue;

    // Brutto aus Netto + ausgewiesener Steuer, nicht über den Satz gerechnet:
    // die Rechnung hat bereits auf Cent gerundet.
    const grossTotal = typeof vatAmount === 'number'
      ? round(netTotal + vatAmount, 2)
      : (typeof vatPct === 'number' ? round(netTotal * (1 + vatPct / 100), 2) : null);

    const basis = classifyUnitPrice({
      unitPrice, quantity, netTotal, grossTotal,
      unitPriceDecimals: decimalsOf(unitPriceRaw),
    });

    const review = [];
    if (basis === 'unknown') review.push('Preis × Menge trifft weder Netto- noch Bruttobetrag');

    charges.push(buildCharge({
      provider: 'ionity',
      id: `ionity:${invoiceNumber || 'ohne-nr'}:${date}:${round(quantity, 3)}`,
      date,
      location,
      kwh: quantity,
      grossTotal,
      netTotal,
      vatRate: typeof vatPct === 'number' ? vatPct / 100 : null,
      unitPriceBasis: basis,
      invoiceNumber,
      invoiceDate,
      reviewReasons: review,
      raw: { line, unitPrice, vatAmount },
    }));
  }

  // Gegenprobe gegen den Rechnungsbetrag.
  if (typeof invoiceTotal === 'number' && charges.length > 0) {
    const sum = round(charges.reduce((s, c) => s + (c.grossTotal ?? 0), 0), 2);
    if (Math.abs(sum - invoiceTotal) > 0.02) {
      for (const c of charges) {
        c.needsReview = true;
        c.reviewReasons = [...c.reviewReasons,
          `Summe der Positionen (${sum.toFixed(2)} €) weicht vom Rechnungsbetrag (${invoiceTotal.toFixed(2)} €) ab`];
      }
    }
  }

  return charges;
}

export default {
  id: 'ionity',
  label: 'IONITY',
  detect: text => /\bIONITY\b/i.test(text) && /EUR\s*\/\s*KWH/i.test(text),
  parse,
};
