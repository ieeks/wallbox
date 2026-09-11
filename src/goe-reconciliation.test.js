import { describe, expect, it } from 'vitest';
import { applyPlanToCharges, buildReconciliationPlan, parseDataV3Csv } from './goe-reconciliation.js';

function csv(rows) {
  return [
    'Session Number;Session Identifier;Start;Ende;Dauer gesamt;Dauer aktiver Stromfluss;max. Leistung [kW];Energie [kWh];Zaehlerstand Anfang [kWh];Zaehlerstand Ende [kWh]',
    ...rows,
  ].join('\n');
}

function charge(id, date, time, kwh, extra = {}) {
  return { id, date, time, kwh, total: +(kwh * 0.24).toFixed(2), bruttoPerKwh: 0.24, source: 'go-e-auto', ...extra };
}

describe('go-e reconciliation', () => {
  it('parst den präzisen data.v3 Export und nutzt die Zählerspanne', () => {
    const sessions = parseDataV3Csv(csv([
      '23;412740_1787945402;28.08.2026 21:30:02;29.08.2026 09:45:25;12:15:23;07:05:00;11,02;78,017;1096,52;1174,537',
    ]));
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      goeSessionId: '412740_1787945402',
      sessionKey: 'goe:412740:1174537',
      meterStartWh: 1096520,
      meterEndWh: 1174537,
      meterKwh: 78.017,
      sourceDeltaKwh: 0,
    });
  });

  it('matcht zuerst über sessionKey und korrigiert einen wh-Offset', () => {
    const sessions = parseDataV3Csv(csv([
      '1;412740_100;01.08.2026 20:00:00;02.08.2026 08:00:00;12:00:00;08:00:00;11,0;15,784;840,34;856,124',
    ]));
    const charges = [charge('a', '2026-08-02', '08:00', 15.900, { sessionKey: 'goe:412740:856124' })];
    const plan = buildReconciliationPlan(charges, sessions);
    expect(plan.summary).toMatchObject({ matched: 1, energyCorrections: 1, unmatchedSource: 0, unmatchedCharges: 0 });
    expect(plan.matches[0].matchMethod).toBe('sessionKey');
    expect(plan.matches[0].changes.kwh).toEqual({ from: 15.9, to: 15.784 });
    expect(plan.matches[0].changes.total.to).toBe(3.79);
  });

  it('matcht Legacy-Einträge konservativ über Endezeit und Energie', () => {
    const sessions = parseDataV3Csv(csv([
      '1;412740_200;06.08.2026 15:31:22;07.08.2026 09:14:40;17:43:18;08:10:00;11,0;81,396;856,124;937,520',
    ]));
    const charges = [charge('legacy', '2026-08-07', '09:14', 81.700)];
    const plan = buildReconciliationPlan(charges, sessions);
    expect(plan.matches[0].matchMethod).toBe('legacy');
    expect(plan.matches[0].changes.sessionKey.to).toBe('goe:412740:937520');
    expect(plan.matches[0].changes.kwh.to).toBe(81.396);
  });

  it('bildet den April-Fall auf zwei bestehende Einträge ab statt eine neue Session zu erzeugen', () => {
    const sessions = parseDataV3Csv(csv([
      '5;412740_1776165005;14.04.2026 13:10:05;14.04.2026 16:30:26;03:20:21;03:19:00;11,0;17,235;171,851;189,086',
      '6;412740_1776177060;14.04.2026 16:31:00;15.04.2026 09:38:05;17:07:05;08:00:00;11,0;59,576;189,086;248,662',
    ]));
    const charges = [
      charge('small', '2026-04-14', '16:30', 17.297),
      charge('aggregate', '2026-04-15', '09:38', 77.187),
    ];
    const plan = buildReconciliationPlan(charges, sessions);
    expect(plan.summary).toMatchObject({ matched: 2, unmatchedSource: 0, unmatchedCharges: 0, energyCorrections: 2, largeMismatches: 1 });
    const small = plan.matches.find(m => m.chargeId === 'small');
    const aggregate = plan.matches.find(m => m.chargeId === 'aggregate');
    expect(small.changes.kwh).toEqual({ from: 17.297, to: 17.235 });
    expect(aggregate.changes.kwh).toEqual({ from: 77.187, to: 59.576 });
    expect(aggregate.mismatchKwh).toBe(17.611);
  });

  it('lässt Mini-Abweichungen bis 0,02 kWh unangetastet', () => {
    const sessions = parseDataV3Csv(csv([
      '1;412740_300;01.09.2026 10:00:00;01.09.2026 11:00:00;01:00:00;01:00:00;11,0;10,000;100,000;110,000',
    ]));
    const charges = [charge('tiny', '2026-09-01', '11:00', 10.018)];
    const plan = buildReconciliationPlan(charges, sessions);
    expect(plan.matches[0].correctEnergy).toBe(false);
    expect(plan.matches[0].changes.kwh).toBeUndefined();
  });

  it('korrigiert keine Quelle, deren Energie und Zählerspanne sich widersprechen', () => {
    const sessions = parseDataV3Csv(csv([
      '1;412740_400;01.09.2026 10:00:00;01.09.2026 11:00:00;01:00:00;01:00:00;11,0;11,000;100,000;110,000',
    ]));
    const charges = [charge('bad-source', '2026-09-01', '11:00', 10.5)];
    const plan = buildReconciliationPlan(charges, sessions);
    expect(plan.summary.sourceInconsistencies).toBe(1);
    expect(plan.matches[0].correctEnergy).toBe(false);
    expect(plan.matches[0].changes.kwh).toBeUndefined();
  });

  it('erzeugt keine fehlenden Sessions automatisch', () => {
    const sessions = parseDataV3Csv(csv([
      '1;412740_500;01.09.2026 10:00:00;01.09.2026 11:00:00;01:00:00;01:00:00;11,0;10,000;100,000;110,000',
    ]));
    const plan = buildReconciliationPlan([], sessions);
    expect(plan.summary).toMatchObject({ matched: 0, unmatchedSource: 1, currentCharges: 0 });
    expect(plan.matches).toHaveLength(0);
  });

  it('wendet einen freigegebenen Plan auditierbar auf eine Kopie an', () => {
    const sessions = parseDataV3Csv(csv([
      '1;412740_600;01.09.2026 10:00:00;01.09.2026 11:00:00;01:00:00;01:00:00;11,0;10,000;100,000;110,000',
    ]));
    const charges = [charge('apply', '2026-09-01', '11:00', 10.4)];
    const plan = buildReconciliationPlan(charges, sessions);
    const next = applyPlanToCharges(charges, plan, '2026-09-11T17:30:00.000Z');
    expect(charges[0].kwh).toBe(10.4);
    expect(next[0].kwh).toBe(10);
    expect(next[0].reconciliation).toMatchObject({ source: 'go-e-data-v3', previousKwh: 10.4, goeSessionId: '412740_600' });
  });
});
