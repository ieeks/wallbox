// =====================================================================
// ELECTRA (Österreich, zweisprachige Rechnung)
// =====================================================================
// Layout weicht stark von Tesla ab: Label und Wert stehen auf derselben
// Zeile, die Übersetzung in der nächsten – „Rechnungsdatum 14/07/2026"
// gefolgt von „Invoicing date".
//
// Positionszeile:
//   Gesamtenergie ⇥ 20% ⇥ 10,315 kWh ⇥ 0,00 € ⇥ 7,12 €
//
// Das Stückpreis-Feld ist 0,00 € und damit unbrauchbar – hier gibt es nichts
// zu verifizieren, es werden nur Menge und Bruttobetrag genommen. Anders als
// bei Tesla ist die Betragsspalte laut Kopf „Preis (inkl. Steuern)", also
// brutto; netto steht separat als „Gesamtbetrag (exkl. Steuern)".
//
// Der Ladeort steht nicht im Kopf, sondern unten im Zahlungsblock, in der
// Zeile NACH „<Datum> à <Uhrzeit> - <Dauer>".
// =====================================================================
import { parseDecimal, round } from '../lib/num.js';
import { buildCharge, toIsoDate } from './charge.js';

const ENERGY_ROW = /^Gesamtenergie\b/i;
const SESSION_LINE = /^(\d{2}\/\d{2}\/\d{4})\s+à\s+(\d{2}:\d{2})\s*-\s*([\d:]+)/;

const cells = line => line.split('\t').map(c => c.trim());

function parse(text) {
  const lines = text.split('\n').filter(Boolean);

  // Die Rechnungsnummer bricht um: „Rechnungsnummer AT-UN20260714-" / „000024"
  let invoiceNumber = null;
  const nrIdx = lines.findIndex(l => /^Rechnungsnummer\b/i.test(l));
  if (nrIdx !== -1) {
    invoiceNumber = cells(lines[nrIdx])[0].replace(/^Rechnungsnummer\s*/i, '').trim();
    if (invoiceNumber.endsWith('-') && lines[nrIdx + 1]) {
      invoiceNumber += cells(lines[nrIdx + 1])[0].trim();
    }
  }

  const invoiceDate = toIsoDate((lines.find(l => /^Rechnungsdatum\b/i.test(l)) || ''));
  const grossTotal = parseDecimal(
    (lines.find(l => /Gesamtbetrag \(inkl\. Steuern\)/i.test(l)) || '').split('\t').pop() || ''
  );
  const netTotal = parseDecimal(
    (lines.find(l => /Gesamtbetrag \(exkl\. Steuern\)/i.test(l)) || '').split('\t').pop() || ''
  );

  const rows = lines.filter(l => ENERGY_ROW.test(l)).map(cells);
  if (rows.length === 0) return [];

  const sessions = [];
  lines.forEach((line, i) => {
    const m = cells(line)[0].match(SESSION_LINE);
    if (!m) return;
    const next = lines[i + 1] ? cells(lines[i + 1])[0] : null;
    sessions.push({ date: toIsoDate(m[1]), time: m[2], duration: m[3], location: next || null });
  });

  // Mehr als eine Energiezeile ohne passend viele Sessions: die Zuordnung
  // wäre geraten. Dann lieber eine Sammelposition mit Prüfhinweis.
  const paired = rows.length === sessions.length;
  const review = [];
  if (!paired && rows.length > 1) {
    review.push(`${rows.length} Energiezeilen, aber ${sessions.length} Ladevorgänge erkannt – Zuordnung bitte prüfen`);
  }

  return rows.map((c, i) => {
    const vatRate = parseDecimal(c[1] || '');
    const kwh = parseDecimal(c[2] || '');
    const rowGross = parseDecimal(c[c.length - 1] || '');
    const session = paired ? sessions[i] : sessions[0];

    const rowReview = [...review];
    if (typeof kwh !== 'number') rowReview.push('Keine kWh-Menge gefunden');

    return buildCharge({
      provider: 'electra',
      id: `electra:${invoiceNumber || 'ohne-nr'}:${session?.date || invoiceDate}`,
      date: session?.date || invoiceDate,
      location: session?.location || null,
      kwh,
      grossTotal: rows.length === 1 ? (grossTotal ?? rowGross) : rowGross,
      netTotal: rows.length === 1 ? netTotal : null,
      vatRate: typeof vatRate === 'number' ? round(vatRate / 100, 4) : null,
      // Das Stückpreis-Feld der Rechnung ist 0,00 € – nichts zu verifizieren.
      unitPriceBasis: 'unknown',
      invoiceNumber,
      invoiceDate,
      reviewReasons: rowReview,
      raw: { row: c, session },
    });
  });
}

export default {
  id: 'electra',
  label: 'Electra',
  detect: text => /Electra Charging/i.test(text) || /go-electra\.com/i.test(text),
  parse,
};
