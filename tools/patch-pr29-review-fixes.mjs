import fs from 'node:fs';

const path = new URL('../script.js', import.meta.url);
let src = fs.readFileSync(path, 'utf8');

function replaceOnce(from, to, label) {
  const first = src.indexOf(from);
  if (first < 0) throw new Error(`Patch marker not found: ${label}`);
  if (src.indexOf(from, first + from.length) >= 0) throw new Error(`Patch marker not unique: ${label}`);
  src = src.replace(from, to);
}

replaceOnce(`// Anzahl tatsächlich gelieferter Dezimalstellen. Wichtig für die Identity Bridge:
// data.v3 liefert den Zähler auf 1 Wh genau (3 Nachkommastellen kWh), der
// App-Export nur auf 10 Wh (2 Nachkommastellen) und darf daher keinen exakten
// eto/sessionKey vortäuschen.
function decimalPlaces(raw) {
  const s = (raw || '').trim();
  const i = Math.max(s.lastIndexOf(','), s.lastIndexOf('.'));
  return i >= 0 ? s.length - i - 1 : 0;
}

`, ``, 'remove decimalPlaces');

replaceOnce(`      const iMeterStart = findCol(cols,
        c => c.includes('zählerstand anfang'), c => c.includes('zaehlerstand anfang'),
        c => c === 'zählerstart', c => c === 'zaehlerstart');
      const iMeterEnd = findCol(cols,
        c => c.includes('zählerstand ende'), c => c.includes('zaehlerstand ende'),
        c => c === 'zählerende', c => c === 'zaehlerende');`, `      // Präzision hängt an der Exportvariante, nicht an der Zahl der gedruckten
      // Nachkommastellen: data.v3 lässt nachlaufende Nullen weg (z.B. 1096,52),
      // bleibt aber Wh-genau. Der App-Export ist dagegen grundsätzlich auf 10 Wh gerundet.
      const iMeterStartData = findCol(cols,
        c => c.includes('zählerstand anfang'), c => c.includes('zaehlerstand anfang'));
      const iMeterEndData = findCol(cols,
        c => c.includes('zählerstand ende'), c => c.includes('zaehlerstand ende'));
      const iMeterStartApp = findCol(cols, c => c === 'zählerstart', c => c === 'zaehlerstart');
      const iMeterEndApp = findCol(cols, c => c === 'zählerende', c => c === 'zaehlerende');
      const iMeterStart = iMeterStartData >= 0 ? iMeterStartData : iMeterStartApp;
      const iMeterEnd = iMeterEndData >= 0 ? iMeterEndData : iMeterEndApp;
      const meterStartExact = iMeterStartData >= 0;
      const meterEndExact = iMeterEndData >= 0;`, 'meter column precision by variant');

replaceOnce(`          const meterStartRaw = iMeterStart >= 0 ? parts[iMeterStart] : '';
          const meterEndRaw = iMeterEnd >= 0 ? parts[iMeterEnd] : '';
          const meterStartKwh = parseNum(meterStartRaw);
          const meterEndKwh = parseNum(meterEndRaw);
          const meterStartExact = isFinite(meterStartKwh) && decimalPlaces(meterStartRaw) >= 3;
          const meterEndExact = isFinite(meterEndKwh) && decimalPlaces(meterEndRaw) >= 3;
          const meterStartWh = meterStartExact ? Math.round(meterStartKwh * 1000) : null;
          const meterEndWh = meterEndExact ? Math.round(meterEndKwh * 1000) : null;`, `          const meterStartRaw = iMeterStart >= 0 ? parts[iMeterStart] : '';
          const meterEndRaw = iMeterEnd >= 0 ? parts[iMeterEnd] : '';
          const meterStartKwh = parseNum(meterStartRaw);
          const meterEndKwh = parseNum(meterEndRaw);
          const meterStartWh = meterStartExact && isFinite(meterStartKwh) ? Math.round(meterStartKwh * 1000) : null;
          const meterEndWh = meterEndExact && isFinite(meterEndKwh) ? Math.round(meterEndKwh * 1000) : null;`, 'per-row exact meter values');

replaceOnce(`            if(meterStartWh !== null && existing.meterStartWh == null) patch.meterStartWh = meterStartWh;
            if(meterEndWh !== null && existing.meterEndWh == null) patch.meterEndWh = meterEndWh;
            if(maxKw !== null && !(existing.maxKw > 0)) patch.maxKw = maxKw;`, `            if(meterStartWh !== null && existing.meterStartWh == null) patch.meterStartWh = meterStartWh;
            if(meterEndWh !== null && existing.meterEndWh == null) patch.meterEndWh = meterEndWh;
            if(meterStartWh !== null && meterEndWh !== null) {
              const spanKwh = (meterEndWh - meterStartWh) / 1000;
              const mismatch = existing.kwh - spanKwh;
              if(Math.abs(mismatch) > 0.02 && existing.energyMismatchKwh == null) {
                patch.energyMismatchKwh = +mismatch.toFixed(3);
              }
            }
            if(maxKw !== null && !(existing.maxKw > 0)) patch.maxKw = maxKw;`, 'record energy mismatch');

replaceOnce(`    sessionKey: 'Zähler-ID', goeSessionId: 'Session-ID', meterStartWh: 'Zähler Start', meterEndWh: 'Zähler Ende',
    maxKw: 'max. Leistung', dauerGesamt: 'Steckdauer', dauer: 'Ladezeit'`, `    sessionKey: 'Zähler-ID', goeSessionId: 'Session-ID', meterStartWh: 'Zähler Start', meterEndWh: 'Zähler Ende',
    energyMismatchKwh: 'Energie-Abweichung kWh',
    maxKw: 'max. Leistung', dauerGesamt: 'Steckdauer', dauer: 'Ladezeit'`, 'preview mismatch label');

fs.writeFileSync(path, src);
console.log('script.js: PR #29 review fixes applied.');
// one-shot trigger
