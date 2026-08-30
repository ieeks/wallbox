// =====================================================================
// TESLA-RECHNUNGEN (AT / DE / IT)
// =====================================================================
// Gleiches Layout, verschiedene Rechtsträger. Erkennung über die USt-IdNr,
// mit dem Firmennamen als Rückfall, falls Tesla die Nummer einmal ändert.
//
// Aufbau der Positionstabelle (Zellen durch \t getrennt, s. itemsToLines):
//   Event-Datum ⇥ Beschreibung ⇥ Preis/Einheit ⇥ Anzahl ⇥ Steuern (%) ⇥ Total
//   2026/08/14  ⇥ Stromgebühr  ⇥ 0.47 / kWh    ⇥ 89.2064 kWh ⇥ 19 ⇥ 35.23
//
// Zwei Dinge, die man der Rechnung ansehen muss:
//
// 1. Die Spalte „Total (EUR)" ist NETTO – sie summiert sich zur Teilsumme,
//    nicht zum Gesamtbetrag. Der Bruttobetrag entsteht erst über den
//    Steuersatz der Zeile. Das ist der verlässliche Weg; der Stückpreis ist
//    es nicht (siehe verify.js).
//
// 2. Beim Minutentarif (ältere Standorte) heissen die Zeilen „Stromgebühr -
//    Stufe 2/3", die Einheit ist `/ min` und es gibt KEINE kWh auf der
//    Rechnung. Solche Ladungen bekommen `kwh: null` und `estimated: true`;
//    geschätzt wird erst im UI, nicht hier.
// =====================================================================
import { parseDecimal, round } from '../lib/num.js';
import { classifyUnitPrice } from './verify.js';

const ENTITIES = [
  { vat: 'ATU67878139',   provider: 'tesla-at', name: /Tesla\s+Motors\s+Austria/i },
  { vat: 'DE265761887',   provider: 'tesla-de', name: /Tesla\s+Germany/i },
  { vat: 'IT07024150968', provider: 'tesla-it', name: /Tesla\s+Italy/i },
];

const DATE_CELL = /^(\d{4})\/(\d{2})\/(\d{2})$/;
const PRICE_CELL = /^([\d.,]+)\s*\/\s*(kWh|min)\b/i;
const QTY_CELL = /^([\d.,]+)\s*(kWh|min)?$/i;
const HEADER_NOISE = /^(\(EUR\)|Preis\/Einheit)$/i;

const cells = line => line.split('\t').map(c => c.trim());

function identify(text) {
  for (const e of ENTITIES) {
    if (text.includes(e.vat)) return e;
  }
  for (const e of ENTITIES) {
    if (e.name.test(text)) return e;
  }
  return null;
}

// „Bernau am Chiemsee, Germany - Hochfellnstraße" → „Bernau am Chiemsee – Hochfellnstraße"
// Der Zusatz hinter dem Land unterscheidet zwei Standorte im selben Ort.
function cleanLocation(raw) {
  if (!raw) return null;
  const m = raw.match(/^(.*?),\s*(?:Austria|Germany|Italy|Österreich|Deutschland|Italien)\s*(?:-\s*(.*))?$/i);
  if (!m) return raw.trim() || null;
  const city = m[1].trim();
  const suffix = (m[2] || '').trim();
  return suffix ? `${city} – ${suffix}` : city;
}

function findLocation(lines) {
  const idx = lines.findIndex(l => /Verkauft an/i.test(l) && /Ladestation/i.test(l));
  if (idx === -1 || idx + 1 >= lines.length) return { location: null, address: null };
  const nameCells = cells(lines[idx + 1]);
  const location = cleanLocation(nameCells[1]);
  // Strasse und PLZ/Ort stehen in den beiden Folgezeilen, ebenfalls rechte Spalte.
  const address = [lines[idx + 2], lines[idx + 3]]
    .filter(Boolean)
    .map(l => cells(l)[1])
    .filter(Boolean)
    .join(', ') || null;
  return { location, address };
}

function field(text, label) {
  const re = new RegExp(`${label}\\s*(?:\\t|\\n)\\s*([^\\t\\n]+)`, 'i');
  const m = text.match(re);
  return m ? m[1].trim() : null;
}

// Positionszeilen zwischen Tabellenkopf und „Teilsumme" einsammeln.
//
// Die Mengenzelle kann umbrechen: bei der Irschenberg-Rechnung steht
// „76.4702" als eigene Zeile ÜBER der Positionszeile und „kWh" als eigene
// Zeile DARUNTER, die Zeile selbst hat dann nur fünf statt sechs Zellen.
// Solche Waisen werden eingesammelt und der Reihe nach zugeordnet.
function collectRows(lines) {
  const start = lines.findIndex(l => /^Event-Datum\b/i.test(l));
  if (start === -1) return [];
  let end = lines.findIndex((l, i) => i > start && /^Teilsumme\b/i.test(l));
  if (end === -1) end = lines.length;

  const rows = [];
  const orphanNumbers = [];
  const orphanUnits = [];

  for (let i = start + 1; i < end; i++) {
    const line = lines[i];
    if (HEADER_NOISE.test(line)) continue;
    const c = cells(line);
    if (DATE_CELL.test(c[0])) { rows.push(c); continue; }
    if (line.includes('\t')) continue;              // sonstige Kopf-/Fussreste
    if (/^[\d.,]+$/.test(line)) orphanNumbers.push(line);
    else if (/^(kWh|min)$/i.test(line)) orphanUnits.push(line);
  }

  return rows.map(c => {
    const priceIdx = c.findIndex(x => PRICE_CELL.test(x));
    let qty = null;
    if (priceIdx !== -1) {
      const after = c.slice(priceIdx + 1, c.length - 2);   // vor Steuer% und Total
      qty = after.find(x => QTY_CELL.test(x)) || null;
    }
    if (!qty && orphanNumbers.length) {
      qty = [orphanNumbers.shift(), orphanUnits.shift() || ''].join(' ').trim();
    }
    return { cells: c, priceCell: priceIdx === -1 ? null : c[priceIdx], qtyCell: qty };
  });
}

function parseRow(row) {
  const c = row.cells;
  const date = c[0].replace(DATE_CELL, '$1-$2-$3');
  const description = c[1] || '';

  // Von hinten lesen: die letzten beiden Zellen sind immer Steuersatz und
  // Zeilensumme, egal wie viele Spalten davor umgebrochen sind.
  const netTotal = parseDecimal(c[c.length - 1]);
  const taxPct = parseDecimal(c[c.length - 2]);

  const priceMatch = row.priceCell ? row.priceCell.match(PRICE_CELL) : null;
  const unitPrice = priceMatch ? parseDecimal(priceMatch[1]) : null;
  const unit = priceMatch ? priceMatch[2].toLowerCase() : null;

  const qtyMatch = row.qtyCell ? row.qtyCell.match(QTY_CELL) : null;
  const quantity = qtyMatch ? parseDecimal(qtyMatch[1]) : null;

  const vatRate = typeof taxPct === 'number' ? taxPct / 100 : null;
  const grossTotal = (typeof netTotal === 'number' && vatRate !== null)
    ? round(netTotal * (1 + vatRate), 2)
    : null;

  const basis = classifyUnitPrice({ unitPrice, quantity, netTotal, grossTotal });

  return { date, description, unit, unitPrice, quantity, netTotal, grossTotal, vatRate, basis };
}

function parse(text) {
  const lines = text.split('\n').map(l => l.replace(/\s+$/, '')).filter(Boolean);
  const entity = identify(text);
  const provider = entity ? entity.provider : 'tesla-at';

  const invoiceNumber = field(text, 'Rechnungsnummer');
  const invoiceDate = (field(text, 'Rechnungsdatum') || '').replace(DATE_CELL, '$1-$2-$3') || null;
  const { location, address } = findLocation(lines);
  const invoiceTotal = parseDecimal(field(text, 'Gesamtbetrag \\(EUR\\)'));

  const parsed = collectRows(lines).map(parseRow).filter(r => typeof r.netTotal === 'number');
  if (parsed.length === 0) return [];

  // Eine Tesla-Rechnung deckt einen Ladestopp ab; mehrere Zeilen sind
  // Tarifstufen derselben Session (Minutentarif: „Stufe 2" + „Stufe 3").
  // Gruppiert wird trotzdem nach Event-Datum – falls doch einmal zwei
  // Sessions auf einer Rechnung landen, werden sie nicht vermischt.
  const groups = new Map();
  for (const row of parsed) {
    if (!groups.has(row.date)) groups.set(row.date, []);
    groups.get(row.date).push(row);
  }

  const charges = [];
  for (const [date, rows] of groups) {
    const netTotal = round(rows.reduce((s, r) => s + r.netTotal, 0), 2);
    const grossTotal = round(rows.reduce((s, r) => s + (r.grossTotal ?? 0), 0), 2);
    const byKwh = rows.every(r => r.unit === 'kwh');
    const byMinute = rows.every(r => r.unit === 'min');

    const kwh = byKwh
      ? round(rows.reduce((s, r) => s + (r.quantity ?? 0), 0), 4)
      : null;
    const minutes = byMinute
      ? round(rows.reduce((s, r) => s + (r.quantity ?? 0), 0), 2)
      : null;

    const bases = [...new Set(rows.map(r => r.basis))];
    const review = [];
    if (bases.includes('unknown')) {
      review.push('Preis × Menge trifft weder Teilsumme noch Gesamtbetrag');
    }
    if (byKwh && !(kwh > 0)) review.push('Keine kWh-Menge gefunden');
    if (!byKwh && !byMinute) review.push('Uneinheitliche Einheit in den Positionen');

    charges.push({
      id: `${provider}:${invoiceNumber || 'ohne-nr'}:${date}`,
      provider,
      date,
      location,
      address,
      kwh,
      minutes,
      grossTotal,
      netTotal,
      grossPerKwh: kwh > 0 ? round(grossTotal / kwh, 6) : null,
      vatRate: rows[0].vatRate,
      // Minutentarif: die Rechnung nennt keine kWh. Der Wert muss im UI
      // geschätzt werden – hier bleibt er bewusst null statt 0.
      estimated: kwh === null,
      needsReview: review.length > 0,
      reviewReasons: review,
      note: '',
      invoiceNumber,
      invoiceDate,
      unitPriceBasis: bases.length === 1 ? bases[0] : 'mixed',
      raw: { rows, invoiceTotal },
    });
  }

  // Gegenprobe: die Summe der Bruttobeträge muss den Gesamtbetrag treffen.
  // Weicht sie ab, hat der Parser die Tabelle falsch gelesen.
  if (typeof invoiceTotal === 'number') {
    const sum = round(charges.reduce((s, c) => s + (c.grossTotal ?? 0), 0), 2);
    if (Math.abs(sum - invoiceTotal) > 0.02) {
      for (const c of charges) {
        c.needsReview = true;
        c.reviewReasons = [...c.reviewReasons,
          `Summe der Positionen (${sum.toFixed(2)} €) weicht vom Gesamtbetrag (${invoiceTotal.toFixed(2)} €) ab`];
      }
    }
  }

  return charges;
}

export default {
  id: 'tesla',
  label: 'Tesla (AT/DE/IT)',
  detect(text) {
    if (ENTITIES.some(e => text.includes(e.vat))) return true;
    return /\bTesla\b/i.test(text) && /Stromgeb(ü|ue)hr/i.test(text);
  },
  parse,
};
