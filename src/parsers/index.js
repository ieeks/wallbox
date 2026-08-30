// =====================================================================
// PARSER-DISPATCHER
// =====================================================================
// Jeder Anbieter liefert ein Modul mit { id, label, detect(text), parse(text) }.
// Der Dispatcher probiert `detect()` der Reihe nach durch. Kein Treffer heisst
// nicht „Fehler", sondern „unerkannt" – die Datei landet im Unerkannt-Bereich
// mit manueller Eingabemaske (und optional dem Claude-Fallback aus §7).
// =====================================================================
import tesla from './tesla.js';

export const PARSERS = [tesla];

export function detectParser(text, parsers = PARSERS) {
  if (typeof text !== 'string' || !text.trim()) return null;
  for (const parser of parsers) {
    try {
      if (parser.detect(text)) return parser;
    } catch (e) {
      console.warn(`Parser ${parser.id} ist an detect() gescheitert:`, e);
    }
  }
  return null;
}

// =====================================================================
// Rechnungstext → Ergebnisobjekt. Wirft nicht: ein kaputter Parser darf den
// Import mehrerer Dateien nicht abbrechen, die Datei geht stattdessen als
// „unerkannt" durch.
// =====================================================================
export function parseInvoiceText(text, { fileName = null, parsers = PARSERS } = {}) {
  const parser = detectParser(text, parsers);
  if (!parser) {
    return { parserId: null, charges: [], unrecognized: true, error: null, fileName };
  }

  try {
    const charges = (parser.parse(text) || []).map(c => ({ ...c, sourceFile: fileName }));
    if (charges.length === 0) {
      return {
        parserId: parser.id,
        charges: [],
        unrecognized: true,
        error: `${parser.label} erkannt, aber keine Ladeposition gefunden.`,
        fileName,
      };
    }
    return { parserId: parser.id, charges, unrecognized: false, error: null, fileName };
  } catch (e) {
    return {
      parserId: parser.id,
      charges: [],
      unrecognized: true,
      error: `${parser.label}: ${e.message}`,
      fileName,
    };
  }
}

// Doppelt eingelesene Rechnungen aussortieren (Edge Case 7). Schlüssel ist die
// vom Parser vergebene deterministische `id` (Anbieter + Rechnungsnummer +
// Event-Datum) – dieselbe Datei zweimal fallen zu lassen legt also keinen
// zweiten Eintrag an, auch nicht unter anderem Dateinamen.
export function dedupeCharges(charges) {
  const seen = new Set();
  return charges.filter(c => {
    const key = c.id || `${c.provider}:${c.date}:${c.grossTotal}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
