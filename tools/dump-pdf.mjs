// Entwicklungswerkzeug: PDF-Rechnung → Textfixture.
//
//   npm run dump-pdf -- rechnung.pdf > fixtures/anbieter-ort.txt
//
// Nutzt bewusst dasselbe `itemsToLines()` wie die App, damit Fixtures und
// Laufzeit nicht auseinanderlaufen. Unterschied: pdf.js kommt hier aus der
// lokalen devDependency (Legacy-Build für Node) statt vom CDN.
//
// Die erzeugte Datei enthält echte Rechnungsdaten – vor dem Commit
// anonymisieren (Name, Anschrift, E-Mail, Kunden-/Rechnungsnummer, S/N).
import { readFileSync } from 'node:fs';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { itemsToLines } from '../src/lib/pdf.js';

const path = process.argv[2];
if (!path) {
  console.error('Aufruf: node tools/dump-pdf.mjs <datei.pdf>');
  process.exit(1);
}

const loadingTask = getDocument({ data: new Uint8Array(readFileSync(path)), useSystemFonts: true });
const doc = await loadingTask.promise;
const out = [];
for (let n = 1; n <= doc.numPages; n++) {
  const page = await doc.getPage(n);
  out.push(...itemsToLines((await page.getTextContent()).items));
  page.cleanup();
}
await loadingTask.destroy();
console.log(out.join('\n'));
