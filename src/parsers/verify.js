// =====================================================================
// NETTO ODER BRUTTO? – der zentrale Fallstrick (Spec §4.1)
// =====================================================================
// `Preis/Einheit` bedeutet je nach Rechnung etwas anderes. Und zwar NICHT
// verlässlich pro Aussteller: in den vorliegenden Tesla-Germany-Rechnungen
// ist der Stückpreis mal netto (0.436865 × 35.2512 = 15,40 = Teilsumme),
// mal brutto (0.47 × 89.2064 = 41,92 = Gesamtbetrag) – gleicher Rechtsträger,
// gleiches Layout, gleicher Monat.
//
// Deshalb wird nicht am Aussteller entschieden, sondern gerechnet: Preis ×
// Menge gegen beide Summen prüfen. Trifft keine, wird geraten – und Raten
// bleibt hier verboten, die Zeile geht mit `needsReview` in die Vorschau.
// =====================================================================
import { approxEqual } from '../lib/num.js';

export const TOLERANCE_EUR = 0.02;

// Wie weit darf Preis × Menge danebenliegen, bevor es ein Lesefehler ist?
//
// Die festen ±0,02 € der Spec reichen nicht, sobald der Stückpreis gerundet
// gedruckt ist. IONITY weist „0.80 EUR/KWH" aus, tatsächlich abgerechnet
// werden 0,8035 – bei 26,707 kWh sind das 9 Cent Abweichung. Mit starrer
// Toleranz gälte jede IONITY-Rechnung als prüfbedürftig.
//
// Der Rundungsfehler wächst mit der Menge: eine auf n Stellen gerundete
// Zahl trägt bis zu 0,5 × 10⁻ⁿ Fehler je Einheit. Genau das ist die Schranke.
export function priceTolerance(quantity, unitPriceDecimals) {
  if (typeof quantity !== 'number' || typeof unitPriceDecimals !== 'number') return TOLERANCE_EUR;
  return Math.max(TOLERANCE_EUR, Math.abs(quantity) * 0.5 * Math.pow(10, -unitPriceDecimals));
}

// → 'net' | 'gross' | 'ambiguous' | 'unknown'
export function classifyUnitPrice({
  unitPrice, quantity, netTotal, grossTotal, unitPriceDecimals = null, tolerance = null,
}) {
  if (typeof unitPrice !== 'number' || typeof quantity !== 'number') return 'unknown';

  const tol = tolerance ?? (unitPriceDecimals === null
    ? TOLERANCE_EUR
    : priceTolerance(quantity, unitPriceDecimals));

  const product = unitPrice * quantity;
  const matchesNet = approxEqual(product, netTotal, tol);
  const matchesGross = approxEqual(product, grossTotal, tol);

  // Bei 0 % Steuer sind beide Summen gleich – dann ist die Frage gegenstandslos,
  // aber eben auch nicht beantwortbar. Ebenso, wenn die Toleranz durch einen
  // grob gerundeten Stückpreis so weit wird, dass sie beide Summen abdeckt.
  if (matchesNet && matchesGross) return 'ambiguous';
  if (matchesNet) return 'net';
  if (matchesGross) return 'gross';
  return 'unknown';
}
