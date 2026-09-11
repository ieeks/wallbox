import { describe, expect, it } from 'vitest';
import { advanceImportState, chooseSessionEnergy, meterSessionKey, normalizeEto } from './goe-import-state.js';

describe('go-e import state', () => {
  it('normalisiert eto aus Zahl oder Ziffernstring', () => {
    expect(normalizeEto(1174537)).toBe(1174537);
    expect(normalizeEto('1174537')).toBe(1174537);
    expect(normalizeEto('1174.537')).toBeNull();
    expect(normalizeEto(-1)).toBeNull();
  });

  it('bildet denselben Session-Key wie der bestehende Auto-Import', () => {
    expect(meterSessionKey('412740', 1174537)).toBe('goe:412740:1174537');
  });

  it('verwendet den letzten Idle-eto als Baseline und liefert das geeichte Delta', () => {
    const idle = advanceImportState(null, {
      serial: '412740', car: 1, totalWh: 1096520, observedAt: '2026-08-28T19:00:00Z',
    }).state;
    const charging = advanceImportState(idle, {
      serial: '412740', car: 2, totalWh: 1101000, observedAt: '2026-08-28T20:00:00Z',
    }).state;
    const done = advanceImportState(charging, {
      serial: '412740', car: 1, totalWh: 1174537, observedAt: '2026-08-29T08:00:00Z',
    });

    expect(done.completed).toEqual({ startEto: 1096520, endEto: 1174537, energyWh: 78017 });
    expect(chooseSessionEnergy(done.completed, 78296.97257741602)).toEqual({
      energyWh: 78017,
      source: 'eto-delta',
      meterStartWh: 1096520,
      meterEndWh: 1174537,
    });
  });

  it('fällt nach Deployment mitten in einer Ladung auf wh zurück', () => {
    const charging = advanceImportState(null, {
      serial: '412740', car: 2, totalWh: 1150000, observedAt: '2026-08-29T07:00:00Z',
    }).state;
    const done = advanceImportState(charging, {
      serial: '412740', car: 1, totalWh: 1174537, observedAt: '2026-08-29T08:00:00Z',
    });

    expect(done.completed).toBeNull();
    expect(chooseSessionEnergy(done.completed, 24537)).toEqual({
      energyWh: 24537,
      source: 'wh-fallback',
      meterStartWh: null,
      meterEndWh: null,
    });
  });

  it('aggregiert zwei Ladephasen, wenn der 15-Minuten-Poller den kurzen Idle-Zustand verpasst', () => {
    const idle = advanceImportState(null, { serial: '412740', car: 1, totalWh: 171851, observedAt: 'a' }).state;
    const phase1 = advanceImportState(idle, { serial: '412740', car: 2, totalWh: 180000, observedAt: 'b' }).state;
    const phase2 = advanceImportState(phase1, { serial: '412740', car: 2, totalWh: 200000, observedAt: 'c' }).state;
    const done = advanceImportState(phase2, { serial: '412740', car: 1, totalWh: 248662, observedAt: 'd' });

    expect(done.completed.energyWh).toBe(76811);
    expect(chooseSessionEnergy(done.completed, 77187).source).toBe('eto-delta');
  });

  it('trennt zwei Ladephasen, wenn der Idle-Zustand dazwischen beobachtet wird', () => {
    const idle0 = advanceImportState(null, { serial: '412740', car: 1, totalWh: 171851, observedAt: 'a' }).state;
    const charging1 = advanceImportState(idle0, { serial: '412740', car: 2, totalWh: 180000, observedAt: 'b' }).state;
    const idle1 = advanceImportState(charging1, { serial: '412740', car: 1, totalWh: 189086, observedAt: 'c' });
    expect(idle1.completed.energyWh).toBe(17235);

    const charging2 = advanceImportState(idle1.state, { serial: '412740', car: 2, totalWh: 200000, observedAt: 'd' }).state;
    const idle2 = advanceImportState(charging2, { serial: '412740', car: 1, totalWh: 248662, observedAt: 'e' });
    expect(idle2.completed.energyWh).toBe(59576);
  });

  it('initialisiert bei sinkendem eto neu statt ein negatives Delta zu erzeugen', () => {
    const previous = {
      version: 1, serial: '412740', lastCar: 2, lastEto: 500000,
      idleEto: 450000, sessionStartEto: 450000, sessionSeenCharging: true, updatedAt: 'a',
    };
    const result = advanceImportState(previous, {
      serial: '412740', car: 1, totalWh: 1000, observedAt: 'b',
    });

    expect(result.reset).toBe(true);
    expect(result.completed).toBeNull();
    expect(result.state.idleEto).toBe(1000);
  });
});
