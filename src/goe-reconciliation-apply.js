import crypto from 'node:crypto';

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

export function legacyApprovalRows(plan) {
  return (plan?.matches || [])
    .filter(m => m.matchMethod === 'legacy')
    .map(m => ({
      chargeId: m.chargeId,
      sessionKey: m.sessionKey,
      goeSessionId: m.goeSessionId,
    }))
    .sort((a, b) => String(a.chargeId).localeCompare(String(b.chargeId)))
    .map(row => ({ ...row, rowHash: sha256(canonical(row)) }));
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
