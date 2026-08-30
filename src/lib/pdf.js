// =====================================================================
// PDF-TEXTEXTRAKTION (pdf.js, dynamisch nachgeladen)
// =====================================================================
// pdf.js ist ~1 MB. Es wird deshalb erst beim ersten Öffnen der Trip-Ansicht
// per Dynamic Import geholt – der normale Ladefuchs-Start bleibt unberührt.
// Die Bibliothek liegt nicht im Repo, sondern kommt von jsDelivr (dieselbe
// Klasse von Abhängigkeit wie Firebase und die Fonts in index.html).
// =====================================================================

export const PDFJS_VERSION = '6.3.289';
const PDFJS_BASE = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/`;

// Weniger Zeichen als das heisst: Das PDF hat keine Textebene (Scan/Foto).
// Kein OCR-Versuch – siehe Edge Case 9 der Spec.
const MIN_TEXT_CHARS = 32;

export class PdfTextError extends Error {
  constructor(message) { super(message); this.name = 'PdfTextError'; }
}

export class PdfLoadError extends Error {
  constructor(message, cause) { super(message); this.name = 'PdfLoadError'; this.cause = cause; }
}

// =====================================================================
// Zwei Bausteine, die pdf.js voraussetzt und Safari erst ab 17.4 mitbringt
// =====================================================================
// Ohne sie bricht schon der erste Import ab. Auf einem iPhone mit iOS < 17.4
// sah das so aus:
//
//   undefined is not a function (near '...t of e...')
//
// Der Schnipsel stammt aus `for await (const t of e)` in getTextContent() –
// pdf.js iteriert dort asynchron über einen ReadableStream. Beide Lücken
// sind klein und exakt definiert, deshalb werden sie hier geschlossen,
// statt auf eine ältere pdf.js-Fassung zurückzugehen. Der Legacy-Build
// hilft übrigens nicht: er benutzt dieselben APIs.
//
// Die Polyfills laufen erst beim Öffnen der Trip-Ansicht und nur, wenn
// wirklich etwas fehlt – der Rest der App merkt davon nichts.
export function applyPdfPolyfills(global = globalThis) {
  if (typeof global.Promise?.withResolvers !== 'function') {
    global.Promise.withResolvers = function withResolvers() {
      let resolve, reject;
      const promise = new global.Promise((res, rej) => { resolve = res; reject = rej; });
      return { promise, resolve, reject };
    };
  }

  const Stream = global.ReadableStream;
  if (Stream && typeof Stream.prototype[Symbol.asyncIterator] !== 'function') {
    Stream.prototype[Symbol.asyncIterator] = function asyncIterator() {
      const reader = this.getReader();
      return {
        // reader.read() liefert bereits { value, done } – genau das
        // Iterator-Protokoll.
        next: () => reader.read(),
        async return(value) {
          await reader.cancel(value);
          return { done: true, value };
        },
        [Symbol.asyncIterator]() { return this; },
      };
    };
  }
}

let pdfjsPromise = null;

export function loadPdfJs() {
  if (!pdfjsPromise) {
    applyPdfPolyfills();
    pdfjsPromise = import(/* @vite-ignore */ `${PDFJS_BASE}pdf.min.mjs`)
      .then(mod => {
        const lib = mod.default ?? mod;
        lib.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}pdf.worker.min.mjs`;
        return lib;
      })
      .catch(err => {
        // Cache leeren, damit ein zweiter Versuch nach einem Netz-Aussetzer greift.
        pdfjsPromise = null;
        throw new PdfLoadError('pdf.js konnte nicht geladen werden (offline?).', err);
      });
  }
  return pdfjsPromise;
}

// =====================================================================
// Textitems einer Seite zu Zeilen zusammensetzen.
//
// `getTextContent()` liefert eine ungeordnete Liste von Fragmenten mit
// Position. Ein blosses `items.map(i => i.str).join(' ')` zerstört genau die
// Struktur, an der die Parser hängen: Rechnungen sind Tabellen.
//
// Deshalb zweistufig:
//   1. Fragmente nach Y-Koordinate zu Zeilen bündeln (PDF-Ursprung = unten
//      links, also absteigend sortieren), innerhalb der Zeile nach X.
//   2. Beim Zusammenfügen die Lücke zum Vorgänger bewerten – ein grosser
//      Abstand ist ein Spaltenwechsel und wird zu `\t`, ein kleiner zu einem
//      Leerzeichen. Die Schwelle hängt an der Schrifthöhe, nicht an einem
//      absoluten Wert, sonst kippt sie mit der Schriftgrösse.
//
// Ergebnis: „2026/04/10\tStromgebühr\t0.47 / kWh\t89.2064 kWh\t19\t35.23" –
// die Parser können auf Zellen zugreifen statt auf Wortabstände zu raten.
// =====================================================================
export function itemsToLines(items, { rowTolerance = 2, colFactor = 1.2, wordFactor = 0.2 } = {}) {
  const rows = [];

  for (const it of items || []) {
    if (!it || !it.str || !it.str.trim()) continue;
    const y = it.transform[5];
    let row = rows.find(r => Math.abs(r.y - y) <= rowTolerance);
    if (!row) { row = { y, items: [] }; rows.push(row); }
    row.items.push(it);
  }

  rows.sort((a, b) => b.y - a.y);

  return rows
    .map(row => {
      row.items.sort((a, b) => a.transform[4] - b.transform[4]);
      let out = '';
      let prevEnd = null;
      for (const it of row.items) {
        const x = it.transform[4];
        const height = Math.abs(it.height) || Math.abs(it.transform[3]) || 8;
        if (prevEnd !== null) {
          const gap = x - prevEnd;
          if (gap > height * colFactor) out += '\t';
          else if (gap > height * wordFactor) out += ' ';
        }
        out += it.str;
        prevEnd = x + (it.width || 0);
      }
      return out.replace(/[ \t]*\t[ \t]*/g, '\t').replace(/ {2,}/g, ' ').trim();
    })
    .filter(Boolean);
}

// =====================================================================
// Eine PDF-Datei zu Zeilen extrahieren.
// `source` ist ein File/Blob (Drop-Zone) oder ein Uint8Array/ArrayBuffer.
// =====================================================================
export async function extractPdfLines(source) {
  const pdfjs = await loadPdfJs();

  let data;
  if (source instanceof Uint8Array) data = source;
  else if (source instanceof ArrayBuffer) data = new Uint8Array(source);
  else data = new Uint8Array(await source.arrayBuffer());

  // Aufgeräumt wird über den LoadingTask, nicht über das Dokument: seit
  // pdf.js 6 hat PDFDocumentProxy kein destroy() mehr.
  const loadingTask = pdfjs.getDocument({ data });
  const doc = await loadingTask.promise;
  const pageCount = doc.numPages;
  const pages = [];

  try {
    for (let n = 1; n <= pageCount; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      pages.push(itemsToLines(content.items));
      page.cleanup();
    }
  } finally {
    await loadingTask.destroy();
  }

  const lines = pages.flat();
  const text = lines.join('\n');

  if (text.replace(/\s/g, '').length < MIN_TEXT_CHARS) {
    throw new PdfTextError(
      'Dieses PDF enthält keine Textebene – vermutlich ein Scan oder Foto. ' +
      'Bitte die Werte von Hand eintragen (eine Texterkennung gibt es hier bewusst nicht).'
    );
  }

  return { text, lines, pages, pageCount };
}
