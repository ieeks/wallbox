// =====================================================================
// Gemeinsamer Bauplan einer geparsten Ladung
// =====================================================================
// Hält die Felder an einer Stelle, damit vier Parser nicht viermal dieselbe
// Liste pflegen – und damit die Regeln, die für alle gelten, nicht je Parser
// neu erfunden werden:
//
//   • `grossPerKwh` ist IMMER grossTotal / kwh, nie der Stückpreis aus der
//     Rechnung. Nur so sind die Anbieter untereinander vergleichbar (§4.1).
//   • Fehlt die kWh-Menge (Minutentarif), bleibt sie `null` und die Ladung
//     ist `estimated` – nie `0`. Ein fehlender Messwert ist keine Null,
//     dieselbe Regel wie beim maxKw-Peak-Tracker.
// =====================================================================
import { round } from '../lib/num.js';

export function buildCharge({
  provider,
  id,
  date,
  location = null,
  address = null,
  kwh = null,
  minutes = null,
  grossTotal = null,
  netTotal = null,
  vatRate = null,
  unitPriceBasis = 'unknown',
  isAggregate = false,
  periodStart = null,
  periodEnd = null,
  invoiceNumber = null,
  invoiceDate = null,
  reviewReasons = [],
  raw = null,
}) {
  const hasKwh = typeof kwh === 'number' && kwh > 0;
  return {
    id,
    provider,
    date,
    location,
    address,
    kwh: hasKwh ? kwh : null,
    minutes,
    grossTotal,
    netTotal,
    grossPerKwh: hasKwh && typeof grossTotal === 'number' ? round(grossTotal / kwh, 6) : null,
    vatRate,
    estimated: !hasKwh,
    isAggregate,
    periodStart,
    periodEnd,
    needsReview: reviewReasons.length > 0,
    reviewReasons,
    note: '',
    invoiceNumber,
    invoiceDate,
    unitPriceBasis,
    raw,
  };
}

// TT/MM/JJJJ bzw. TT.MM.JJJJ → ISO. Bewusst kein Date-Parsing: „10/07/2026"
// ist in allen hier vorkommenden Rechnungen der 10. Juli, `new Date()` läse
// daraus je nach Umgebung den 7. Oktober.
export function toIsoDate(raw) {
  if (typeof raw !== 'string') return null;
  const m = raw.match(/(\d{2})[./](\d{2})[./](\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}
