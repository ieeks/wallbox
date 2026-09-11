import crypto from 'node:crypto';

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function chargeTimestampMs(charge) {
  if (!charge?.date) return NaN;
  const raw = String(charge.time || '12:00').slice(0, 8);
  const time = raw.length === 5 ? `${raw}:00` : raw;
  return Date.parse(`${charge.date}T${time}`);
}

function meterEndFromSessionKey(sessionKey) {
  const parts = String(sessionKey || '').split(':');
  const value = Number(parts[2]);
  return Number.isSafeInteger(value) ? value : null;
}

function mapsForReview(charges = [], sessions = []) {
  return {
    chargeById: new Map(charges.map(c => [c.id, c])),
    sessionById: new Map(sessions.map(s => [s.goeSessionId, s])),
  };
}

export function legacyApprovalRows(plan, charges = [], sessions = []) {
  const { chargeById, sessionById } = mapsForReview(charges, sessions);
  return (plan?.matches || [])
    .filter(m => m.matchMethod === 'legacy')
    .map(m => {
      const identity = {
        chargeId: m.chargeId,
        sessionKey: m.sessionKey,
        goeSessionId: m.goeSessionId,
      };
      const charge = chargeById.get(m.chargeId);
      const session = sessionById.get(m.goeSessionId);
      return {
        ...identity,
        // IMPORTANT: review is display-only. The approval hash intentionally
        // covers only the identity triplet so wording/display changes do not
        // invalidate a previously reviewed mapping.
        rowHash: sha256(canonical(identity)),
        review: charge || session ? {
          chargeDate: charge?.date || null,
          chargeTime: charge?.time || null,
          chargeKwh: Number.isFinite(Number(charge?.kwh)) ? Number(charge.kwh) : null,
          sourceStart: session?.start ? `${session.start.date} ${session.start.time}` : null,
          sourceEnd: session?.end ? `${session.end.date} ${session.end.time}` : null,
          sourceKwh: Number.isFinite(Number(session?.energyKwh)) ? Number(session.energyKwh) : null,
          mismatchKwh: m.mismatchKwh ?? null,
          meterStartWh: session?.meterStartWh ?? null,
          meterEndWh: session?.meterEndWh ?? null,
        } : null,
      };
    })
    .sort((a, b) => String(a.chargeId).localeCompare(String(b.chargeId)));
}

export function matchMethodCounts(plan) {
  return (plan?.matches || []).reduce((acc, match) => {
    const key = match.matchMethod || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

export function reconciliationHashes(charges, sourceCsv, plan) {
  const currentFingerprint = sha256(canonical(charges));
  const sourceFingerprint = sha256(sourceCsv);
  const planHash = sha256(canonical({ currentFingerprint, sourceFingerprint, plan }));
  const legacyRows = legacyApprovalRows(plan);
  const legacyRowHashes = legacyRows.map(row => row.rowHash);
  const legacyApprovalRoot = legacyRows.length ? sha256(canonical(legacyRowHashes)) : null;
  return {
    currentFingerprint,
    sourceFingerprint,
    planHash,
    legacyApprovalRoot,
    legacyRowHashes,
  };
}

export function assertReconciliationGates(plan, totals) {
  const s = plan?.summary || {};
  if (s.unmatchedSource !== 0) throw new Error(`Gate: unmatchedSource=${s.unmatchedSource}`);
  if (s.unmatchedCharges !== 0) throw new Error(`Gate: unmatchedCharges=${s.unmatchedCharges}`);
  if (s.sourceInconsistencies !== 0) throw new Error(`Gate: sourceInconsistencies=${s.sourceInconsistencies}`);
  if (s.matched !== s.sourceSessions || s.matched !== s.currentCharges) {
    throw new Error(`Gate: matched=${s.matched}, source=${s.sourceSessions}, current=${s.currentCharges}`);
  }
  if (Number(totals?.projectedKwhTotal).toFixed(3) !== Number(totals?.sourceKwhTotal).toFixed(3)) {
    throw new Error(`Gate: projected ${Number(totals?.projectedKwhTotal).toFixed(3)} != source ${Number(totals?.sourceKwhTotal).toFixed(3)}`);
  }
}

function mappedPairs(charges, sessions, plan) {
  const { chargeById, sessionById } = mapsForReview(charges, sessions);
  return (plan?.matches || []).map(match => {
    const charge = chargeById.get(match.chargeId);
    const session = sessionById.get(match.goeSessionId);
    if (!charge || !session) throw new Error(`Gate: Mapping-Daten fehlen für ${match.chargeId}/${match.goeSessionId}`);
    const chargeMs = chargeTimestampMs(charge);
    if (!Number.isFinite(chargeMs)) throw new Error(`Gate: ungültiger Bestands-Zeitstempel für ${match.chargeId}`);
    if (!Number.isSafeInteger(session.meterStartWh) || !Number.isSafeInteger(session.meterEndWh)) {
      throw new Error(`Gate: ungültige Quell-Zählerwerte für ${match.goeSessionId}`);
    }
    const keyMeterEnd = meterEndFromSessionKey(match.sessionKey);
    if (keyMeterEnd !== session.meterEndWh) {
      throw new Error(`Gate: sessionKey/Zählerende widersprechen sich für ${match.goeSessionId}`);
    }
    return { match, charge, session, chargeMs };
  });
}

export function assertMeterOrderConsistent(charges, sessions, plan) {
  const pairs = mappedPairs(charges, sessions, plan);
  const byChargeTime = pairs.slice()
    .sort((a, b) => a.chargeMs - b.chargeMs || String(a.charge.id).localeCompare(String(b.charge.id)))
    .map(x => x.session.goeSessionId);
  const byMeter = pairs.slice()
    .sort((a, b) => a.session.meterEndWh - b.session.meterEndWh)
    .map(x => x.session.goeSessionId);
  const inversions = byChargeTime.reduce((count, id, i) => count + (id === byMeter[i] ? 0 : 1), 0);
  if (inversions) {
    throw new Error(`Gate: Zähler- und Zeitordnung widersprechen sich (${inversions} Inversionen)`);
  }
}

export function assertMeterChainConsistent(charges, sessions, plan) {
  const pairs = mappedPairs(charges, sessions, plan)
    .sort((a, b) => a.chargeMs - b.chargeMs || String(a.charge.id).localeCompare(String(b.charge.id)));
  const source = pairs.slice().sort((a, b) => a.session.meterEndWh - b.session.meterEndWh);

  // Compare the actual source gap pattern instead of requiring a gap-free chain.
  // The historical export legitimately contains a 39 Wh gap during commissioning.
  const signature = list => list.map((x, i) => ({
    id: x.session.goeSessionId,
    gapWh: i === 0 ? null : x.session.meterStartWh - list[i - 1].session.meterEndWh,
  }));
  if (canonical(signature(pairs)) !== canonical(signature(source))) {
    throw new Error('Gate: zugeordnete Zählerkette entspricht nicht der Quell-Zählerkette');
  }
}

export function assertLegacyMismatchProfile(charges, sessions, plan, {
  ordinaryRelativeLimit = 0.015,
  maxOutliers = 1,
  largeOutlierMinRelative = 0.20,
} = {}) {
  const pairs = mappedPairs(charges, sessions, plan).filter(x => x.match.matchMethod === 'legacy');
  const outliers = [];
  for (const { charge, session, match } of pairs) {
    const oldKwh = Number(charge.kwh);
    const sourceKwh = Number(session.energyKwh);
    if (!Number.isFinite(oldKwh) || !Number.isFinite(sourceKwh) || sourceKwh <= 0) {
      throw new Error(`Gate: ungültige Energie für Legacy-Match ${match.chargeId}`);
    }
    const relative = Math.abs(oldKwh - sourceKwh) / sourceKwh;
    if (relative > ordinaryRelativeLimit) outliers.push({ chargeId: match.chargeId, relative });
  }
  if (outliers.length > maxOutliers) {
    throw new Error(`Gate: ${outliers.length} Legacy-Energieausreißer > ${(ordinaryRelativeLimit * 100).toFixed(1)}%`);
  }
  if (outliers.length === 1 && outliers[0].relative < largeOutlierMinRelative) {
    throw new Error(`Gate: unerwarteter mittlerer Legacy-Ausreißer ${(outliers[0].relative * 100).toFixed(2)}%`);
  }
}

export function assertLegacyMappingStructurallyConsistent(charges, sessions, plan) {
  assertMeterOrderConsistent(charges, sessions, plan);
  assertMeterChainConsistent(charges, sessions, plan);
  assertLegacyMismatchProfile(charges, sessions, plan);
}

export function assertIdentityBackfillReady(plan, approvedLegacyRoot, actualLegacyRoot) {
  const counts = matchMethodCounts(plan);
  const legacy = counts.legacy || 0;
  if (legacy < 1) throw new Error('Identity-Backfill nicht nötig: keine Legacy-Matches vorhanden');
  if (!approvedLegacyRoot || !/^[a-f0-9]{64}$/i.test(approvedLegacyRoot)) {
    throw new Error('approved_legacy_root muss ein vollständiger SHA-256 Hash sein');
  }
  if (approvedLegacyRoot !== actualLegacyRoot) {
    throw new Error('Legacy-Zuordnungen entsprechen nicht der freigegebenen zeilenweisen Mapping-Root');
  }
}

export function assertFinalApplyReady(plan) {
  const counts = matchMethodCounts(plan);
  if ((counts.legacy || 0) > 0) {
    throw new Error(`Voll-Apply blockiert: ${counts.legacy} Matches laufen noch über legacy`);
  }
  const stable = (counts.sessionKey || 0) + (counts.goeSessionId || 0);
  if (stable !== (plan?.summary?.matched || 0)) {
    throw new Error('Voll-Apply blockiert: nicht alle Matches verwenden stabile Identitäten');
  }
}

export function identityBackfillToCharges(charges, plan, backfilledAt) {
  const legacyMap = new Map((plan?.matches || [])
    .filter(m => m.matchMethod === 'legacy')
    .map(m => [m.chargeId, m]));

  return (charges || []).map(charge => {
    const item = legacyMap.get(charge.id);
    if (!item) return charge;
    if (charge.sessionKey || charge.goeSessionId) {
      throw new Error(`Legacy-Backfill würde bestehende Identität überschreiben: ${charge.id}`);
    }
    return {
      ...charge,
      sessionKey: item.sessionKey,
      goeSessionId: item.goeSessionId,
      identityBackfill: {
        source: 'go-e-data-v3',
        goeSessionId: item.goeSessionId,
        backfilledAt,
      },
    };
  });
}
