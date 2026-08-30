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

// → 'net' | 'gross' | 'ambiguous' | 'unknown'
export function classifyUnitPrice({ unitPrice, quantity, netTotal, grossTotal, tolerance = TOLERANCE_EUR }) {
  if (typeof unitPrice !== 'number' || typeof quantity !== 'number') return 'unknown';
  const product = unitPrice * quantity;
  const matchesNet = approxEqual(product, netTotal, tolerance);
  const matchesGross = approxEqual(product, grossTotal, tolerance);

  // Bei 0 % Steuer sind beide Summen gleich – dann ist die Frage gegenstandslos,
  // aber eben auch nicht beantwortbar.
  if (matchesNet && matchesGross) return 'ambiguous';
  if (matchesNet) return 'net';
  if (matchesGross) return 'gross';
  return 'unknown';
}
