import { describe, expect, it } from 'vitest';
import {
  assertFinalApplyReady,
  assertIdentityBackfillReady,
  assertLegacyMappingStructurallyConsistent,
  assertLegacyMismatchProfile,
  assertMeterChainConsistent,
  assertMeterOrderConsistent,
  assertReconciliationGates,
  identityBackfillToCharges,
  legacyApprovalRows,
  matchMethodCounts,
  reconciliationHashes,
} from './goe-reconciliation-apply.js';

describe('go-e reconciliation apply safety', () => {
  const basePlan = {
    matches: [
      { chargeId: 'a', matchMethod: 'legacy', sessionKey: 'goe:412740:1000', goeSessionId: '412740_1', mismatchKwh: 0.1 },
      { chargeId: 'b', matchMethod: 'sessionKey', sessionKey: 'goe:412740:2000', goeSessionId: '412740_2', mismatchKwh: 0 },
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

  it('bildet eine stabile zeilenweise Legacy-Approval-Root mit lesbarer Review-Hilfe', () => {
    const charges = [{ id: 'a', date: '2026-03-24', time: '11:15', kwh: 72.324 }, { id: 'b' }];
    const sessions = [{
      goeSessionId: '412740_1',
      start: { date: '2026-03-23', time: '20:00:00' },
      end: { date: '2026-03-24', time: '11:20:00' },
      energyKwh: 72.324,
      meterStartWh: 100,
      meterEndWh: 1000,
    }];
    const rows = legacyApprovalRows(basePlan, charges, sessions);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ chargeId: 'a', sessionKey: 'goe:412740:1000', goeSessionId: '412740_1' });
    expect(rows[0].review).toMatchObject({
      chargeDate: '2026-03-24',
      chargeTime: '11:15',
      chargeKwh: 72.324,
      sourceKwh: 72.324,
      meterEndWh: 1000,
    });
    expect(rows[0].rowHash).toMatch(/^[a-f0-9]{64}$/);

    // Display-only review values are deliberately not part of the approval hash.
    const changedDisplay = legacyApprovalRows(basePlan, [{ ...charges[0], kwh: 99 }, charges[1]], sessions);
    expect(changedDisplay[0].rowHash).toBe(rows[0].rowHash);

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

  it('erkennt eine vertauschte Legacy-Zuordnung über Zähler-/Zeitordnung', () => {
    const charges = [
      { id: 'july-a', date: '2026-07-14', time: '08:00', kwh: 10 },
      { id: 'july-b', date: '2026-07-24', time: '08:00', kwh: 10.003 },
    ];
    const sessions = [
      { goeSessionId: 's1', energyKwh: 10, meterStartWh: 1000, meterEndWh: 11000 },
      { goeSessionId: 's2', energyKwh: 10.003, meterStartWh: 11000, meterEndWh: 21003 },
    ];
    const good = {
      matches: [
        { chargeId: 'july-a', matchMethod: 'legacy', goeSessionId: 's1', sessionKey: 'goe:412740:11000' },
        { chargeId: 'july-b', matchMethod: 'legacy', goeSessionId: 's2', sessionKey: 'goe:412740:21003' },
      ],
    };
    const swapped = {
      matches: [
        { chargeId: 'july-a', matchMethod: 'legacy', goeSessionId: 's2', sessionKey: 'goe:412740:21003' },
        { chargeId: 'july-b', matchMethod: 'legacy', goeSessionId: 's1', sessionKey: 'goe:412740:11000' },
      ],
    };
    expect(() => assertMeterOrderConsistent(charges, sessions, good)).not.toThrow();
    expect(() => assertLegacyMappingStructurallyConsistent(charges, sessions, good)).not.toThrow();
    expect(() => assertMeterOrderConsistent(charges, sessions, swapped)).toThrow(/Zähler- und Zeitordnung/);
  });

  it('akzeptiert legitime Zählerlücken, prüft aber die Quell-Kette', () => {
    const charges = [
      { id: 'a', date: '2026-03-09', time: '10:00', kwh: 1 },
      { id: 'b', date: '2026-03-24', time: '10:00', kwh: 0.961 },
    ];
    const sessions = [
      { goeSessionId: 's1', energyKwh: 1, meterStartWh: 0, meterEndWh: 1000 },
      { goeSessionId: 's2', energyKwh: 0.961, meterStartWh: 1039, meterEndWh: 2000 },
    ];
    const plan = { matches: [
      { chargeId: 'a', matchMethod: 'legacy', goeSessionId: 's1', sessionKey: 'goe:412740:1000' },
      { chargeId: 'b', matchMethod: 'legacy', goeSessionId: 's2', sessionKey: 'goe:412740:2000' },
    ] };
    expect(() => assertMeterChainConsistent(charges, sessions, plan)).not.toThrow();
  });

  it('blockiert ein verdächtiges Legacy-Mismatch-Profil', () => {
    const charges = [
      { id: 'a', date: '2026-01-01', time: '10:00', kwh: 10.5 },
      { id: 'b', date: '2026-01-02', time: '10:00', kwh: 10.5 },
    ];
    const sessions = [
      { goeSessionId: 's1', energyKwh: 10, meterStartWh: 0, meterEndWh: 10000 },
      { goeSessionId: 's2', energyKwh: 10, meterStartWh: 10000, meterEndWh: 20000 },
    ];
    const plan = { matches: [
      { chargeId: 'a', matchMethod: 'legacy', goeSessionId: 's1', sessionKey: 'goe:412740:10000' },
      { chargeId: 'b', matchMethod: 'legacy', goeSessionId: 's2', sessionKey: 'goe:412740:20000' },
    ] };
    expect(() => assertLegacyMismatchProfile(charges, sessions, plan)).toThrow(/2 Legacy-Energieausreißer/);
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
