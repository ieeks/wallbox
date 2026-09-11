import { describe, expect, it } from 'vitest';
import './charge-sync.js';

const { sameSession, deletionMarker, importSession } = globalThis.ChargeSync;

describe('go-e session identity hierarchy', () => {
  it('behandelt sessionKey als stärkste Identität', () => {
    const a = { sessionKey: 'goe:412740:189086', goeSessionId: 'same' };
    const b = { sessionKey: 'goe:412740:248662', goeSessionId: 'same' };
    expect(sameSession(a, b)).toBe(false);
  });

  it('nutzt goeSessionId wenn nicht auf beiden Seiten ein sessionKey vorhanden ist', () => {
    const a = { goeSessionId: '412740_1776165005' };
    const b = { sessionKey: 'goe:412740:189086', goeSessionId: '412740_1776165005' };
    expect(sameSession(a, b)).toBe(true);
  });

  it('nimmt goeSessionId in Löschmarker auf', () => {
    expect(deletionMarker({
      id: 'x', goeSessionId: '412740_1776165005', date: '2026-04-14', time: '13:10',
    })).toEqual({
      id: 'x', goeSessionId: '412740_1776165005', date: '2026-04-14', time: '13:10',
    });
  });

  it('reichert einen bestehenden Legacy-Eintrag mit stabilen Kennungen an', () => {
    const cloud = { charges: [{
      id: 'legacy-1', goeSessionId: '412740_1776165005', date: '2026-04-14', time: '13:10', kwh: 17.297,
    }], settings: {} };
    const entry = {
      id: 'goe-412740-189086', sessionKey: 'goe:412740:189086', goeSessionId: '412740_1776165005',
      sessionDate: '2026-04-14', sessionTime: '13:10', date: '2026-04-14', time: '13:10', kwh: 17.235,
    };

    const result = importSession(cloud, [], entry);
    expect(result.imported).toBe(false);
    expect(result.charges).toHaveLength(1);
    expect(result.charges[0].id).toBe('legacy-1');
    expect(result.charges[0].sessionKey).toBe('goe:412740:189086');
    expect(result.charges[0].goeSessionId).toBe('412740_1776165005');
    expect(result.charges[0].kwh).toBe(17.297); // Reconciliation ist bewusst P1.
  });
});
