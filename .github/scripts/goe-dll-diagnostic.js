const serial = process.env.GOE_SERIAL;
const token = process.env.GOE_TOKEN;
if (!serial || !token) throw new Error('GOE_SERIAL/GOE_TOKEN fehlen');

function redactDll(value) {
  if (typeof value === 'string') {
    try {
      const u = new URL(value);
      return { kind: 'url', origin: u.origin, path: u.pathname, hasQuery: Boolean(u.search) };
    } catch {
      return { kind: 'string', length: value.length };
    }
  }
  if (Array.isArray(value)) return value.map(redactDll);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, redactDll(v)]));
  return { kind: typeof value };
}

function findUrl(value) {
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value)) return value;
    if (value.startsWith('/')) return `https://${serial}.api.v3.go-e.io${value}`;
    return null;
  }
  if (Array.isArray(value)) for (const v of value) { const found = findUrl(v); if (found) return found; }
  if (value && typeof value === 'object') for (const v of Object.values(value)) { const found = findUrl(v); if (found) return found; }
  return null;
}

function safeUrl(raw, base) {
  try {
    const u = new URL(raw, base);
    return { origin: u.origin, path: u.pathname, queryKeys: [...u.searchParams.keys()].sort() };
  } catch { return null; }
}

function detectDelim(line) {
  const candidates = [';', '\t', ','];
  return candidates.sort((a,b) => line.split(b).length - line.split(a).length)[0];
}

function parseCsvLine(line, delim) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (q && line[i+1] === '"') { cur += '"'; i++; }
      else q = !q;
    } else if (ch === delim && !q) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

const norm = s => String(s ?? '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
function decimalPlaces(raw) {
  const s = String(raw ?? '').trim();
  const i = Math.max(s.lastIndexOf(','), s.lastIndexOf('.'));
  return i >= 0 ? s.length - i - 1 : 0;
}

const statusRes = await fetch(`https://${serial}.api.v3.go-e.io/api/status`, { headers: { Authorization: `Bearer ${token}` } });
if (!statusRes.ok) throw new Error(`status HTTP ${statusRes.status}`);
const status = await statusRes.json();
console.log('dll shape:', JSON.stringify(redactDll(status.dll)));
const url = findUrl(status.dll);
if (!url) {
  console.log('::warning::dll enthält keinen direkt verwendbaren Download-Link.');
  process.exit(0);
}

let exportRes = await fetch(url, { redirect: 'follow' });
if (exportRes.status === 401 || exportRes.status === 403) exportRes = await fetch(url, { redirect: 'follow', headers: { Authorization: `Bearer ${token}` } });
if (!exportRes.ok) throw new Error(`dll download HTTP ${exportRes.status}`);
const text = await exportRes.text();
const contentType = exportRes.headers.get('content-type') || 'unknown';

if (/text\/html/i.test(contentType) || /^\s*</.test(text)) {
  const urls = new Map();
  const attrRe = /\b(?:href|src|action)\s*=\s*["']([^"']+)["']/gi;
  for (const m of text.matchAll(attrRe)) {
    const s = safeUrl(m[1], url);
    if (s) urls.set(`${s.origin}${s.path}?${s.queryKeys.join(',')}`, s);
  }
  const absoluteRe = /https?:\/\/[^\s"'<>]+/gi;
  for (const m of text.matchAll(absoluteRe)) {
    const s = safeUrl(m[0].replace(/&amp;/g, '&'), url);
    if (s) urls.set(`${s.origin}${s.path}?${s.queryKeys.join(',')}`, s);
  }
  const keywordLines = text.split(/\r?\n/)
    .filter(l => /direct|download|csv|json|export/i.test(l))
    .map(l => l.replace(/https?:\/\/[^\s"'<>]+/gi, x => {
      const s = safeUrl(x.replace(/&amp;/g, '&'), url);
      return s ? `${s.origin}${s.path}?[${s.queryKeys.join(',')}]` : '[url]';
    }).replace(/[A-Za-z0-9_-]{30,}/g, '[redacted]'))
    .map(l => l.trim()).filter(Boolean).slice(0, 25);
  console.log('portalUrlShapes=' + JSON.stringify([...urls.values()]));
  console.log('portalKeywordLines=' + JSON.stringify(keywordLines));
  console.log(`contentType=${contentType}`);
  console.log(`bytes=${Buffer.byteLength(text, 'utf8')}`);
  process.exit(0);
}

const first = text.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] || '';
const delim = detectDelim(first);
const headers = parseCsvLine(first, delim).map(s => s.trim());
const cols = headers.map(norm);
const rows = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean).slice(1).map(r => parseCsvLine(r, delim));
const idx = (...names) => cols.findIndex(c => names.includes(c));
const iStartData = idx('zahlerstand anfang');
const iEndData = idx('zahlerstand ende');
const iStartApp = idx('zahlerstart');
const iEndApp = idx('zahlerende');
const iSessionIdentifier = idx('session identifier');
const iSessionId = idx('session id');
const variant = (iStartData >= 0 && iEndData >= 0) ? 'data-v3-precise' : (iStartApp >= 0 && iEndApp >= 0) ? 'app-export-rounded' : 'unknown';
const meterIdxs = [iStartData, iEndData, iStartApp, iEndApp].filter(i => i >= 0);
const dp = new Set();
for (const row of rows) for (const i of meterIdxs) if (row[i] != null && String(row[i]).trim()) dp.add(decimalPlaces(row[i]));
console.log(`exportVariant=${variant}`);
console.log(`rowCount=${rows.length}`);
console.log(`delimiter=${JSON.stringify(delim)}`);
console.log(`headers=${headers.join(' | ')}`);
console.log(`meterDecimalPlaces=${[...dp].sort((a,b)=>a-b).join(',') || 'n/a'}`);
console.log(`sessionIdColumn=${iSessionIdentifier >= 0 ? 'Session Identifier' : iSessionId >= 0 ? 'Session ID' : 'none'}`);
console.log(`contentType=${contentType}`);
console.log(`bytes=${Buffer.byteLength(text, 'utf8')}`);
