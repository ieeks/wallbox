const serial = process.env.GOE_SERIAL;
const token = process.env.GOE_TOKEN;
if (!serial || !token) throw new Error('GOE_SERIAL/GOE_TOKEN fehlen');

function redactDll(value) {
  if (typeof value === 'string') {
    try { const u = new URL(value); return { kind:'url', origin:u.origin, path:u.pathname, hasQuery:Boolean(u.search) }; }
    catch { return { kind:'string', length:value.length }; }
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
  if (Array.isArray(value)) for (const v of value) { const f = findUrl(v); if (f) return f; }
  if (value && typeof value === 'object') for (const v of Object.values(value)) { const f = findUrl(v); if (f) return f; }
  return null;
}

function safeUrl(raw, base) {
  try { const u = new URL(raw, base); return { origin:u.origin, path:u.pathname, queryKeys:[...u.searchParams.keys()].sort() }; }
  catch { return null; }
}

function sanitizeLine(line, base) {
  return line
    .replace(/https?:\/\/[^\s"'<>]+/gi, x => { const s = safeUrl(x.replace(/&amp;/g,'&'), base); return s ? `${s.origin}${s.path}?[${s.queryKeys.join(',')}]` : '[url]'; })
    .replace(/([?&](?:e|token|key|auth|secret)=)[^&"'\s]+/gi, '$1[redacted]')
    .replace(/[A-Za-z0-9_-]{30,}/g, '[redacted]')
    .trim();
}

const statusRes = await fetch(`https://${serial}.api.v3.go-e.io/api/status`, { headers:{ Authorization:`Bearer ${token}` } });
if (!statusRes.ok) throw new Error(`status HTTP ${statusRes.status}`);
const status = await statusRes.json();
console.log('dll shape:', JSON.stringify(redactDll(status.dll)));
const url = findUrl(status.dll);
if (!url) { console.log('::warning::dll ohne Download-Link'); process.exit(0); }

let res = await fetch(url, { redirect:'follow' });
if (res.status === 401 || res.status === 403) res = await fetch(url, { redirect:'follow', headers:{ Authorization:`Bearer ${token}` } });
if (!res.ok) throw new Error(`dll HTTP ${res.status}`);
const html = await res.text();
const ct = res.headers.get('content-type') || '';
console.log(`portalContentType=${ct}`);

const inputNames = [...html.matchAll(/<(?:input|select|button)\b[^>]*\bname=["']([^"']+)["'][^>]*>/gi)].map(m => m[1]);
console.log('formFieldNames=' + JSON.stringify([...new Set(inputNames)]));
const scripts = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)].map(m => new URL(m[1], url).href);
console.log('scriptPaths=' + JSON.stringify(scripts.map(s => safeUrl(s, url))));

for (const scriptUrl of scripts.filter(s => /export\.js(?:$|\?)/i.test(s))) {
  const jsRes = await fetch(scriptUrl);
  if (!jsRes.ok) { console.log(`exportJsHttp=${jsRes.status}`); continue; }
  const js = await jsRes.text();
  const interesting = js.split(/\r?\n/).filter(l => /fetch\(|XMLHttpRequest|FormData|permalink|download|csv|json|URLSearchParams|\.action|POST|GET/i.test(l));
  console.log('exportJsInteresting=' + JSON.stringify(interesting.slice(0,80).map(l => sanitizeLine(l, url))));
  const endpointShapes = new Map();
  for (const m of js.matchAll(/["'`](\/[^"'`\s]+)["'`]/g)) {
    const s = safeUrl(m[1], url); if (s) endpointShapes.set(`${s.origin}${s.path}?${s.queryKeys.join(',')}`, s);
  }
  console.log('exportJsEndpointShapes=' + JSON.stringify([...endpointShapes.values()]));
}
