const serial = process.env.GOE_SERIAL;
const token = process.env.GOE_TOKEN;
if (!serial || !token) throw new Error('GOE_SERIAL/GOE_TOKEN fehlen');

function findUrl(value) {
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value)) return value;
    if (value.startsWith('/')) return `https://${serial}.api.v3.go-e.io${value}`;
    return null;
  }
  if (Array.isArray(value)) for (const v of value) { const f = findUrl(v); if (f) return f; }
  if (value && typeof value === 'object') for (const v of Object.values(value)) { const f = findUrl(v); if (f) return f; }
  return null;
}

function sanitize(line) {
  return line
    .replace(/([?&](?:e|token|key|auth|secret)=)[^&"'\s]+/gi, '$1[redacted]')
    .replace(/[A-Za-z0-9_-]{30,}/g, '[redacted]')
    .trim();
}

const statusRes = await fetch(`https://${serial}.api.v3.go-e.io/api/status`, { headers:{ Authorization:`Bearer ${token}` } });
if (!statusRes.ok) throw new Error(`status HTTP ${statusRes.status}`);
const status = await statusRes.json();
const url = findUrl(status.dll);
if (!url) throw new Error('dll ohne URL');
const pageRes = await fetch(url);
if (!pageRes.ok) throw new Error(`portal HTTP ${pageRes.status}`);
const html = await pageRes.text();
const scriptMatch = html.match(/<script\b[^>]*\bsrc=["']([^"']*export\.js[^"']*)["']/i);
if (!scriptMatch) throw new Error('export.js nicht gefunden');
const scriptUrl = new URL(scriptMatch[1], url).href;
const jsRes = await fetch(scriptUrl);
if (!jsRes.ok) throw new Error(`export.js HTTP ${jsRes.status}`);
const lines = (await jsRes.text()).split(/\r?\n/);

for (const marker of ['let lessGetParams', 'let getParams', 'let jsonGetParams', "fetch('/api/v1/get_ticket", 'function getTicket', "direct_export?'", "direct_json?'"]) {
  const i = lines.findIndex(l => l.includes(marker));
  if (i < 0) continue;
  const from = Math.max(0, i - 4), to = Math.min(lines.length, i + 14);
  console.log(`--- ${marker} ---`);
  for (let n = from; n < to; n++) console.log(`${String(n+1).padStart(4,'0')}: ${sanitize(lines[n])}`);
}
