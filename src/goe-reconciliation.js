// Pure reconciliation logic for go-e data.v3 exports.
// This module never reads/writes Firestore; callers decide whether a plan is only
// previewed or later applied after an explicit approval.

const normalizeHeader = value => String(value ?? '')
  .trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

function parseNum(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return NaN;
  return Number.parseFloat(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s);
}

function parseCsvLine(line, delim) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { cur += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === delim && !quoted) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function detectDelimiter(headerLine) {
  return [';', '\t', ','].sort((a, b) => headerLine.split(b).length - headerLine.split(a).length)[0];
}

function parseGoEDateTime(raw) {
  const [d, t = '00:00:00'] = String(raw ?? '').trim().split(/\s+/, 2);
  const p = d.split('.');
  if (p.length !== 3) return null;
  const year = p[2].length === 2 ? `20${p[2]}` : p[2];
  const date = `${year}-${p[1].padStart(2, '0')}-${p[0].padStart(2, '0')}`;
  const time = t.slice(0, 8);
  const ms = Date.parse(`${date}T${time || '00:00:00'}`);
  return Number.isFinite(ms) ? { date, time, ms } : null;
}

export function parseDataV3Csv(text) {
  const lines = String(text ?? '').replace(/^\uFEFF/, '').replace(/\r/g, '').split('\n').filter(Boolean);
  if (lines.length < 2) throw new Error('go-e Export ist leer oder unvollständig');
  const delim = detectDelimiter(lines[0]);
  const rows = lines.map(line => parseCsvLine(line, delim));
  const headers = rows[0].map(normalizeHeader);
  const find = (...tests) => {
    for (const test of tests) {
      const i = headers.findIndex(test);
      if (i >= 0) return i;
    }
    return -1;
  };

  const iSession = find(c => c === 'session identifier');
  const iStart = find(c => c === 'start');
  const iEnd = find(c => c === 'ende');
  const iEnergy = find(c => c === 'energie [kwh]', c => c === 'energie');
  const iMeterStart = find(c => c.startsWith('zaehlerstand anfang'));
  const iMeterEnd = find(c => c.startsWith('zaehlerstand ende'));
  const iMaxKw = find(c => c.startsWith('max. leistung'), c => c.startsWith('max leistung'));
  const iDuration = find(c => c === 'dauer aktiver stromfluss');
  const iPlugDuration = find(c => c === 'dauer gesamt');

  if ([iSession, iStart, iEnd, iEnergy, iMeterStart, iMeterEnd].some(i => i < 0)) {
    throw new Error('Kein präziser data.v3-Export: Pflichtspalten fehlen');
  }

  const sessions = [];
  for (let n = 1; n < rows.length; n++) {
    const row = rows[n];
    const goeSessionId = String(row[iSession] ?? '').trim();
    const serialMatch = goeSessionId.match(/^([^_]+)_/);
    const start = parseGoEDateTime(row[iStart]);
    const end = parseGoEDateTime(row[iEnd]);
    const energyKwh = parseNum(row[iEnergy]);
    const meterStartKwh = parseNum(row[iMeterStart]);
    const meterEndKwh = parseNum(row[iMeterEnd]);
    if (!goeSessionId || !serialMatch || !start || !end || !Number.isFinite(energyKwh)
      || !Number.isFinite(meterStartKwh) || !Number.isFinite(meterEndKwh)) continue;

    const serial = serialMatch[1];
    const meterStartWh = Math.round(meterStartKwh * 1000);
    const meterEndWh = Math.round(meterEndKwh * 1000);
    const meterKwh = (meterEndWh - meterStartWh) / 1000;
    // The meter span is the authoritative quantity. The exported energy column is
    // kept for diagnostics; an unexpectedly large disagreement blocks correction.
    const sourceDeltaKwh = +(energyKwh - meterKwh).toFixed(3);
    sessions.push({
      goeSessionId,
      serial,
      sessionKey: `goe:${serial}:${meterEndWh}`,
      start,
      end,
      energyKwh,
      meterStartWh,
      meterEndWh,
      meterKwh: +meterKwh.toFixed(3),
      sourceDeltaKwh,
      maxKw: iMaxKw >= 0 && Number.isFinite(parseNum(row[iMaxKw])) ? parseNum(row[iMaxKw]) : null,
      dauer: iDuration >= 0 ? String(row[iDuration] ?? '').trim() || null : null,
      dauerGesamt: iPlugDuration >= 0 ? String(row[iPlugDuration] ?? '').trim() || null : null,
    });
  }
  if (!sessions.length) throw new Error('Keine gültigen data.v3-Sessions gefunden');
  return sessions.sort((a, b) => a.start.ms - b.start.ms);
}

function chargeMs(charge) {
  if (!charge?.date) return NaN;
  const time = String(charge.time || '12:00').slice(0, 8);
  return Date.parse(`${charge.date}T${time.length === 5 ? `${time}:00` : time}`);
}

function legacyScore(charge, session) {
  const cm = chargeMs(charge);
  if (!Number.isFinite(cm)) return null;
  const timeDistHours = Math.abs(cm - session.end.ms) / 3600000;
  if (timeDistHours > 30) return null;
  const oldKwh = Number(charge.kwh);
  if (!Number.isFinite(oldKwh)) return null;
  const absKwh = Math.abs(oldKwh - session.meterKwh);
  const relKwh = absKwh / Math.max(session.meterKwh, 0.001);
  const energyClose = absKwh <= Math.max(1.25, session.meterKwh * 0.02);
  const veryCloseTime = timeDistHours <= 8;
  if (!energyClose && !veryCloseTime) return null;
  return timeDistHours + Math.min(relKwh * 100, 50) * 0.25;
}

function recalculatedTotal(charge, newKwh) {
  const unit = Number(charge.bruttoPerKwh);
  if (Number.isFinite(unit) && unit >= 0) return Math.round(newKwh * unit * 100) / 100;
  const oldKwh = Number(charge.kwh);
  const oldTotal = Number(charge.total);
  if (Number.isFinite(oldKwh) && oldKwh > 0 && Number.isFinite(oldTotal) && oldTotal >= 0) {
    return Math.round(newKwh * (oldTotal / oldKwh) * 100) / 100;
  }
  return null;
}

export function buildReconciliationPlan(charges, sessions, { energyToleranceKwh = 0.02, sourceToleranceKwh = 0.01 } = {}) {
  const currentCharges = Array.isArray(charges) ? charges : [];
  const sourceSessions = Array.isArray(sessions) ? sessions : [];
  const usedChargeIds = new Set();
  const matches = [];
  const unmatchedSource = [];

  for (const session of sourceSessions) {
    let charge = currentCharges.find(c => !usedChargeIds.has(c.id) && c.sessionKey && c.sessionKey === session.sessionKey);
    let method = charge ? 'sessionKey' : null;
    if (!charge) {
      charge = currentCharges.find(c => !usedChargeIds.has(c.id) && c.goeSessionId && c.goeSessionId === session.goeSessionId);
      if (charge) method = 'goeSessionId';
    }
    if (!charge) {
      const ranked = currentCharges
        .filter(c => !usedChargeIds.has(c.id) && !c.sessionKey && !c.goeSessionId)
        .map(c => ({ charge: c, score: legacyScore(c, session) }))
        .filter(x => x.score !== null)
        .sort((a, b) => a.score - b.score);
      if (ranked.length && (!ranked[1] || ranked[1].score - ranked[0].score >= 2)) {
        charge = ranked[0].charge;
        method = 'legacy';
      }
    }

    if (!charge) {
      unmatchedSource.push({ sessionKey: session.sessionKey, goeSessionId: session.goeSessionId });
      continue;
    }
    usedChargeIds.add(charge.id);

    const oldKwh = Number(charge.kwh);
    const mismatchKwh = Number.isFinite(oldKwh) ? +(oldKwh - session.meterKwh).toFixed(3) : null;
    const sourceConsistent = Math.abs(session.sourceDeltaKwh) <= sourceToleranceKwh;
    const correctEnergy = sourceConsistent && mismatchKwh !== null && Math.abs(mismatchKwh) > energyToleranceKwh;
    const changes = {};

    const fill = (key, value) => {
      if (value !== null && value !== undefined && (charge[key] === null || charge[key] === undefined || charge[key] === '')) {
        changes[key] = { from: charge[key] ?? null, to: value };
      }
    };
    fill('sessionKey', session.sessionKey);
    fill('goeSessionId', session.goeSessionId);
    fill('meterStartWh', session.meterStartWh);
    fill('meterEndWh', session.meterEndWh);
    fill('maxKw', session.maxKw);
    fill('dauer', session.dauer);
    fill('dauerGesamt', session.dauerGesamt);

    if (correctEnergy) {
      changes.kwh = { from: oldKwh, to: session.meterKwh };
      const newTotal = recalculatedTotal(charge, session.meterKwh);
      if (newTotal !== null && Number(charge.total) !== newTotal) changes.total = { from: charge.total ?? null, to: newTotal };
      if (charge.energyMismatchKwh !== undefined) changes.energyMismatchKwh = { from: charge.energyMismatchKwh, to: null };
    } else if (mismatchKwh !== null && Math.abs(mismatchKwh) > energyToleranceKwh) {
      fill('energyMismatchKwh', mismatchKwh);
    }

    matches.push({
      chargeId: charge.id,
      matchMethod: method,
      sessionKey: session.sessionKey,
      goeSessionId: session.goeSessionId,
      mismatchKwh,
      sourceDeltaKwh: session.sourceDeltaKwh,
      sourceConsistent,
      correctEnergy,
      changes,
    });
  }

  const unmatchedCharges = currentCharges
    .filter(c => !usedChargeIds.has(c.id))
    .map(c => ({ id: c.id, date: c.date || null, source: c.source || null }));

  return {
    matches,
    unmatchedSource,
    unmatchedCharges,
    summary: {
      sourceSessions: sourceSessions.length,
      currentCharges: currentCharges.length,
      matched: matches.length,
      unmatchedSource: unmatchedSource.length,
      unmatchedCharges: unmatchedCharges.length,
      energyCorrections: matches.filter(m => m.correctEnergy).length,
      largeMismatches: matches.filter(m => m.mismatchKwh !== null && Math.abs(m.mismatchKwh) > 1).length,
      metadataChanges: matches.filter(m => Object.keys(m.changes).some(k => !['kwh', 'total', 'energyMismatchKwh'].includes(k))).length,
      sourceInconsistencies: matches.filter(m => !m.sourceConsistent).length,
    },
  };
}

export function applyPlanToCharges(charges, plan, reconciledAt) {
  const changeMap = new Map(plan.matches.map(m => [m.chargeId, m]));
  return charges.map(charge => {
    const item = changeMap.get(charge.id);
    if (!item || !Object.keys(item.changes).length) return charge;
    const next = { ...charge };
    for (const [key, change] of Object.entries(item.changes)) {
      if (change.to === null || change.to === undefined) delete next[key];
      else next[key] = change.to;
    }
    next.reconciliation = {
      source: 'go-e-data-v3',
      goeSessionId: item.goeSessionId,
      previousKwh: item.changes.kwh?.from ?? charge.kwh,
      reconciledAt,
    };
    return next;
  });
}
