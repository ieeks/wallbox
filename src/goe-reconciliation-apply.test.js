import { describe, expect, it } from 'vitest';
import {
  assertFinalApplyReady,
  assertIdentityBackfillReady,
  assertReconciliationGates,
  identityBackfillToCharges,
  legacyApprovalRows,
  matchMethodCounts,
  reconciliationHashes,
} from './goe-reconciliation-apply.js';

describe('go-e reconciliation apply safety', () => {
  const basePlan = {
    matches: [
      { chargeId: 'a', matchMethod: 'legacy', sessionKey: 'goe:412740:1000', goeSessionId: '412740_1' },
      { chargeId: 'b', matchMethod: 'sessionKey', sessionKey: 'goe:412740:2000', goeSessionId: '412740_2' },
    ],
    summary: {
      sourceSessions: 2,
      currentCharges: 2,
      matched: 2,
      unmatchedSource: 0,
      unmatchedCharges: 0,
      sourceInconsistencies: 0,
    },
  };

  it('bildet eine stabile zeilenweise Legacy-Approval-Root', () => {
    const rows = legacyApprovalRows(basePlan);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ chargeId: 'a', sessionKey: 'goe:412740:1000', goeSessionId: '412740_1' });
    expect(rows[0].rowHash).toMatch(/^[a-f0-9]{64}$/);

    const hashes = reconciliationHashes([{ id: 'a' }, { id: 'b' }], 'csv', basePlan);
    expect(hashes.legacyApprovalRoot).toMatch(/^[a-f0-9]{64}$/);
    expect(hashes.legacyRowHashes).toEqual([rows[0].rowHash]);
  });

  it('backfillt ausschließlich stabile Identitäten und lässt Messwerte unangetastet', () => {
    const charges = [
      { id: 'a', kwh: 17.297, total: 4.15, maxKw: 6.2, date: '2026-04-14', time: '16:30' },
      { id: 'b', kwh: 10, sessionKey: 'goe:412740:2000', goeSessionId: '412740_2' },
    ];
    const next = identityBackfillToCharges(charges, basePlan, '2026-09-11T20:00:00.000Z');
    expect(next[0]).toMatchObject({
      kwh: 17.297,
      total: 4.15,
      maxKw: 6.2,
      date: '2026-04-14',
      time: '16:30',
      sessionKey: 'goe:412740:1000',
      goeSessionId: '412740_1',
    });
    expect(next[0].identityBackfill.source).toBe('go-e-data-v3');
    expect(next[1]).toEqual(charges[1]);
    expect(charges[0].sessionKey).toBeUndefined();
  });

  it('verlangt die exakt freigegebene Legacy-Root für Phase 1', () => {
    const hashes = reconciliationHashes([{ id: 'a' }, { id: 'b' }], 'csv', basePlan);
    expect(() => assertIdentityBackfillReady(basePlan, hashes.legacyApprovalRoot, hashes.legacyApprovalRoot)).not.toThrow();
    expect(() => assertIdentityBackfillReady(basePlan, '0'.repeat(64), hashes.legacyApprovalRoot)).toThrow(/Legacy-Zuordnungen/);
  });

  it('blockiert den Voll-Apply solange ein Legacy-Match existiert', () => {
    expect(matchMethodCounts(basePlan)).toEqual({ legacy: 1, sessionKey: 1 });
    expect(() => assertFinalApplyReady(basePlan)).toThrow(/legacy/);

    const stablePlan = {
      ...basePlan,
      matches: basePlan.matches.map((m, i) => ({ ...m, matchMethod: i ? 'goeSessionId' : 'sessionKey' })),
    };
    expect(() => assertFinalApplyReady(stablePlan)).not.toThrow();
  });

  it('blockiert bei Unmatched, Quellenfehlern oder falscher Zielsumme', () => {
    expect(() => assertReconciliationGates(basePlan, { sourceKwhTotal: 20, projectedKwhTotal: 20 })).not.toThrow();
    expect(() => assertReconciliationGates({ ...basePlan, summary: { ...basePlan.summary, unmatchedSource: 1 } }, { sourceKwhTotal: 20, projectedKwhTotal: 20 })).toThrow(/unmatchedSource/);
    expect(() => assertReconciliationGates(basePlan, { sourceKwhTotal: 20, projectedKwhTotal: 20.001 })).toThrow(/projected/);
  });
});
