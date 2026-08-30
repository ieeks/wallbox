// =====================================================================
// ZAHLEN AUS RECHNUNGSTEXT
// =====================================================================
// Die Anbieter mischen die Formate, teils innerhalb einer Zeile:
//   IONITY: „0.80 EUR/KWH | 26,707 KWH | 3,87 EUR" – Punkt beim Preis,
//   Komma bei Menge und Beträgen.
//
// Bewusst getrennt von `parseNum()` in script.js: das ist der CSV-Import und
// setzt voraus, dass in EINER Datei entweder Komma ODER Punkt der Dezimal-
// trenner ist. Für Rechnungen gilt das nicht, und der CSV-Pfad soll sich
// dadurch nicht ändern.
// =====================================================================

// Bündelung wie „1.234" / „1,234": Erste Gruppe 1–3 Ziffern, alle weiteren
// exakt 3, und durchgehend dasselbe Trennzeichen.
function isGrouped(part) {
  if (!/^\d+(?:[.,]\d+)*$/.test(part)) return false;
  const seps = part.match(/[.,]/g);
  if (!seps) return true;
  if (!seps.every(ch => ch === seps[0])) return false;
  const chunks = part.split(/[.,]/);
  if (chunks[0].length < 1 || chunks[0].length > 3) return false;
  return chunks.slice(1).every(c => c.length === 3);
}

// =====================================================================
// Eine Zahl aus einem Textstück lesen. Gibt `null` zurück, wenn nichts
// Verwertbares drinsteht – nie NaN, damit Aufrufer nicht versehentlich
// weiterrechnen.
//
// Heuristik für den Dezimaltrenner (Spec §4.3): Das letzte Trennzeichen ist
// der Dezimalpunkt – ausser es folgen exakt drei Ziffern UND es gibt ein
// weiteres Trennzeichen DESSELBEN Zeichens. Dann ist es ein Tausenderpunkt.
//
//   26,707      → 26.707    (nur ein Trenner: Dezimal – kWh-Menge, kein 26707)
//   1.234,56    → 1234.56   (letzter Trenner andersartig → Dezimal)
//   1,234.56    → 1234.56
//   1.234.567   → 1234567   (drei Ziffern, gleicher Trenner → Gruppierung)
//   1.234,567   → 1234.567  (gemischt → letzter ist Dezimal)
//   0,274980    → 0.27498   (sechs Nachkommastellen sind bei Tesla normal)
//
// Der Zusatz „desselben Zeichens" steht so nicht in der Spec, ist aber nötig:
// ohne ihn liest „1.234,567" als 1234567. Gemischte Trenner sind nie beide
// Gruppentrenner.
// =====================================================================
export function parseDecimal(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;

  const match = raw
    .replace(/[\u00a0\u202f\u2009]/g, ' ')
    .match(/([-+\u2212])?\s*(\d[\d.,]*)/);
  if (!match) return null;

  const sign = (match[1] === '-' || match[1] === '−') ? -1 : 1;
  const body = match[2].replace(/[.,]+$/, '');
  if (!body) return null;

  const seps = body.match(/[.,]/g);
  if (!seps) {
    const n = Number(body);
    return Number.isFinite(n) ? sign * n : null;
  }

  const lastIdx = Math.max(body.lastIndexOf('.'), body.lastIndexOf(','));
  const tail = body.slice(lastIdx + 1);
  const uniform = seps.every(ch => ch === seps[0]);
  const lastIsGroupSep = tail.length === 3 && seps.length > 1 && uniform;

  const intPart = lastIsGroupSep ? body : body.slice(0, lastIdx);
  const fracPart = lastIsGroupSep ? '' : tail;

  if (!isGrouped(intPart)) return null;

  const n = Number(intPart.replace(/[.,]/g, '') + (fracPart ? '.' + fracPart : ''));
  return Number.isFinite(n) ? sign * n : null;
}

// Auf `digits` Nachkommastellen runden (kaufmännisch, ohne Float-Artefakte
// wie 0.1+0.2). `null` bleibt `null`.
export function round(n, digits = 2) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  // Über die Exponentialschreibweise runden statt über *100/100: sonst kippt
  // 1.005 wegen der Float-Darstellung auf 1.00 statt 1.01.
  const shifted = Math.round(Number(`${n}e${digits}`));
  return Number(`${shifted}e-${digits}`);
}

// Betragsvergleich mit Toleranz – für die Netto/Brutto-Verifikation (±0,02 €).
export function approxEqual(a, b, tolerance = 0.02) {
  if (typeof a !== 'number' || typeof b !== 'number') return false;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= tolerance + 1e-9;
}
