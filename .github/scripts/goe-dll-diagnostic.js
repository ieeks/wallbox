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

function detectDelim(line) {
  const c = [';', '\t', ','];
  return c.sort((a,b) => line.split(b).length - line.split(a).length)[0];
}
function parseLine(line, delim) {
  const out=[]; let cur=''; let q=false;
  for (let i=0;i<line.length;i++) {
    const ch=line[i];
    if (ch==='"') { if(q && line[i+1]==='"'){cur+='"';i++;} else q=!q; }
    else if(ch===delim && !q){out.push(cur);cur='';}
    else cur+=ch;
  }
  out.push(cur); return out;
}
const norm=s=>String(s??'').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
const decimalPlaces=raw=>{const s=String(raw??'').trim(); const i=Math.max(s.lastIndexOf(','),s.lastIndexOf('.')); return i>=0?s.length-i-1:0;};

const statusRes = await fetch(`https://${serial}.api.v3.go-e.io/api/status`, { headers:{ Authorization:`Bearer ${token}` } });
if (!statusRes.ok) throw new Error(`status HTTP ${statusRes.status}`);
const status = await statusRes.json();
const portalUrl = findUrl(status.dll);
if (!portalUrl) throw new Error('dll ohne URL');
const p = new URL(portalUrl);
const e = p.searchParams.get('e');
if (!e) throw new Error('dll ohne e-Parameter');
const direct = new URL('/api/v1/direct_export', p.origin);
direct.searchParams.set('e', e);
const res = await fetch(direct, { redirect:'follow' });
if (!res.ok) throw new Error(`direct_export HTTP ${res.status}`);
const text = await res.text();
const lines = text.replace(/^\uFEFF/,'').split(/\r?\n/).filter(Boolean);
const first = lines[0] || '';
const delim = detectDelim(first);
const headers = parseLine(first, delim).map(s=>s.trim());
const cols = headers.map(norm);
const rows = lines.slice(1).map(r=>parseLine(r,delim));
const idx=(...names)=>cols.findIndex(c=>names.includes(c));
const iStart=idx('zahlerstand anfang','zahlerstart');
const iEnd=idx('zahlerstand ende','zahlerende');
const iSessionIdentifier=idx('session identifier');
const iSessionId=idx('session id');
const meterDp=new Set();
for(const row of rows) for(const i of [iStart,iEnd]) if(i>=0 && String(row[i]??'').trim()) meterDp.add(decimalPlaces(row[i]));
const variant = cols.includes('zahlerstand anfang') && cols.includes('zahlerstand ende') ? 'data-v3-precise'
  : cols.includes('zahlerstart') && cols.includes('zahlerende') ? 'app-export-rounded' : 'unknown';
console.log(`variant=${variant}`);
console.log(`rows=${rows.length}`);
console.log(`delimiter=${JSON.stringify(delim)}`);
console.log(`headers=${headers.join(' | ')}`);
console.log(`meterDecimalPlaces=${[...meterDp].sort((a,b)=>a-b).join(',') || 'n/a'}`);
console.log(`sessionIdColumn=${iSessionIdentifier>=0?'Session Identifier':iSessionId>=0?'Session ID':'none'}`);
console.log(`contentType=${res.headers.get('content-type') || 'unknown'}`);
console.log(`bytes=${Buffer.byteLength(text,'utf8')}`);
