import { describe, it, expect } from 'vitest';
import './charge-sync.js';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const S = globalThis.ChargeSync;
const a = { id: 'a', date: '2026-08-29', time: '06:00', kwh: 78.3, lch: 123, total: 17.95 };
const newer = { ...a, id: 'new', date: '2026-09-09', lch: 456 };
const state = (charges = [a]) => ({ charges, settings: { theme: 'light', defaultEnergy: 0.14 } });

describe('charge reconciliation', () => {
  it('keeps a new auto-import when an older phone saves settings', () => {
    const ops = S.changes(state(), { ...state(), settings: { ...state().settings, theme: 'dark' } });
    const result = S.apply(state([a, newer]), [], ops);
    expect(result.charges.map(c => c.id)).toEqual(['new', 'a']);
    expect(result.settings.theme).toBe('dark');
  });
  it('does not restore a deletion from a stale phone or legacy seed', () => {
    const deleted = S.apply(state(), [], [{ type: 'remove', entry: a }]);
    for (const type of ['put', 'seed']) {
      expect(S.apply(deleted, deleted.deleted, [{ type, entry: a }]).charges).toEqual([]);
    }
  });
  it('keeps the surviving original when deleting only a duplicate', () => {
    const duplicate = { ...a, id: 'dup' };
    const result = S.apply(state([a, duplicate]), [], [{ type: 'remove', entry: duplicate }]);
    expect(result.charges).toEqual([a]);
  });
  it('blocks auto-reimport of a deleted session with a newly generated ID', () => {
    const deleted = S.apply(state(), [], [{ type: 'remove', entry: a }]);
    const result = S.importSession(deleted, deleted.deleted, { ...a, id: 'another' });
    expect(result.imported).toBe(false);
    expect(result.charges).toEqual([]);
  });
  it('deduplicates across reboot by cumulative meter endpoint', () => {
    const original = { ...a, sessionKey: 'goe:123456:100000' };
    const rebooted = { ...newer, sessionKey: original.sessionKey, lch: 9 };
    expect(S.importSession(state([original]), [], rebooted).charges).toHaveLength(1);
    expect(S.importSession(state([]), [S.deletionMarker(original)], rebooted).imported).toBe(false);
  });
  it('keeps two actual equal-kWh sessions, even if boot-relative lch is reused', () => {
    const first = { ...a, sessionKey: 'goe:123456:100000' };
    const second = { ...a, id: 'second', sessionKey: 'goe:123456:178300' };
    expect(S.importSession(state([first]), [], second).charges).toHaveLength(2);
    expect(S.sameSession(a, { ...a, date: '2026-09-09' })).toBe(false);
    expect(S.sameSession(a, { ...a, time: '19:00' })).toBe(false);
  });
  it('keeps manual edits when enriching a legacy session', () => {
    const original = { ...a, total: 42 };
    const result = S.importSession(state([original]), [], { ...a, id: 'meter', sessionKey: 'goe:123456:100000', sessionDate: a.date, sessionTime: a.time });
    expect(result.charges[0]).toMatchObject({ id: 'a', total: 42, sessionKey: 'goe:123456:100000' });
  });
  it('never deduplicates manual entries just because amount and date match', () => {
    expect(S.sameSession({ ...a, lch: null }, { ...a, id: 'b', lch: null })).toBe(false);
  });
});

// Exercise the actual browser sync functions with a transactional Firestore double.
// No production Firebase/go-e access. The double can retry callbacks and delay commits.
function browser(initial = state(), storage = new Map()) {
  const source = readFileSync(new URL('../script.js', import.meta.url), 'utf8');
  const dbData = { household: S.copy(initial), deleted: { entries: [] } };
  const events = [];
  let hook = null, fail = false;
  const db = {
    collection: () => ({ doc: id => ({ id: id === 'haushalt' ? 'household' : 'deleted' }) }),
    runTransaction: async callback => {
      if (fail) throw Error('offline');
      const attempt = async () => {
        const writes = [];
        const value = await callback({
          get: async ref => ({ exists: true, data: () => S.copy(dbData[ref.id]) }),
          set: (ref, value) => writes.push([ref.id, value]),
        });
        return { writes, value };
      };
      let result = await attempt();
      if (hook) { const h = hook; hook = null; await h(); result = await attempt(); }
      for (const [key, value] of result.writes) dbData[key] = value;
      return result.value;
    },
  };
  let n = 0;
  const context = vm.createContext({ ChargeSync: S, db, firebaseReady: true,
    HOUSEHOLD_DOC: 'haushalt', charges: S.copy(initial.charges), settings: S.copy(initial.settings),
    firebase: { firestore: { FieldValue: { serverTimestamp: () => 1 } } },
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) },
    crypto: { randomUUID: () => `op-${++n}` }, console: { error() {} },
    setSyncStatus: status => events.push(status), refreshDashboard() {},
  });
  vm.runInContext(source.slice(source.indexOf('const SYNC_OUTBOX'), source.indexOf('// =====================================================================\n// AUFKLAPPBARE')), context);
  vm.runInContext(source.slice(source.indexOf('async function syncToCloud()'), source.indexOf('\nfunction deduplicateCharges')), context);
  return { context, dbData, storage, events, sync: () => context.syncToCloud(),
    hook: fn => { hook = fn; }, offline: value => { fail = value; } };
}

describe('browser transaction integration', () => {
  it('preserves concurrent auto-import and retries with the latest cloud list', async () => {
    const b = browser();
    await b.sync();
    b.context.settings.theme = 'dark';
    b.hook(() => { b.dbData.household.charges.push(S.copy(newer)); });
    await b.sync();
    expect(b.dbData.household.charges.map(c => c.id)).toEqual(['new', 'a']);
    expect(b.context.charges).toHaveLength(2);
  });
  it('deletion wins against another device saving its stale entry', async () => {
    const b = browser();
    await b.sync();
    b.dbData.deleted.entries = [S.deletionMarker(a)];
    b.dbData.household.charges = [];
    b.context.charges[0].total = 99;
    await b.sync();
    expect(b.dbData.household.charges).toEqual([]);
    expect(b.context.charges).toEqual([]);
  });
  it('retains an offline deletion across reload and acknowledges only after commit', async () => {
    const b = browser();
    await b.sync();
    b.offline(true);
    b.context.charges = [];
    expect(await b.sync()).toBe(false);
    expect(JSON.parse(b.storage.get('lf_charge_outbox'))).toHaveLength(1);
    const reloaded = browser(state([]), b.storage);
    reloaded.dbData.household = state();
    await reloaded.sync();
    expect(reloaded.dbData.household.charges).toEqual([]);
    expect(JSON.parse(b.storage.get('lf_charge_outbox'))).toEqual([]);
  });
  it('does not lose a deletion performed during an in-flight transaction', async () => {
    const b = browser();
    await b.sync();
    b.context.settings.theme = 'dark';
    b.hook(() => { b.context.charges = []; b.context.captureSyncChanges(); });
    await b.sync();
    expect(b.context.charges).toEqual([]);
    expect(b.dbData.household.charges).toEqual([]);
    expect(b.dbData.deleted.entries[0].id).toBe('a');
  });
  it('leaves failed sync marked offline, without clearing pending changes', async () => {
    const b = browser();
    b.offline(true);
    b.context.settings.theme = 'dark';
    await b.sync();
    expect(b.events.at(-1)).toBe('offline');
    expect(JSON.parse(b.storage.get('lf_charge_outbox')).length).toBeGreaterThan(0);
  });
});

it('merges a local field edit without discarding concurrently enriched metadata', () => {
  const before = state();
  const after = state([{ ...a, total: 20 }]);
  const result = S.apply(state([{ ...a, sessionKey: 'meter-key', maxKw: 11 }]), [], S.changes(before, after));
  expect(result.charges[0]).toMatchObject({ total: 20, sessionKey: 'meter-key', maxKw: 11 });
});

function importer() {
  let source = readFileSync(new URL('../.github/scripts/goe-import.js', import.meta.url), 'utf8');
  source = source.replace(/^import .*;\n/gm, '').split('\nrun().catch')[0];
  const data = { haushalt: state([]), 'charge-deletions': { entries: [] }, 'goe-peak-tracker': { maxW: 11000, samples: 5 } };
  const status = { car: 1, wh: 78300, eto: 200000, lch: 1000, rbt: 10000, lccfc: 9000, cdi: { value: 3600000 } };
  let beforeTransaction = null, fail = false;
  const snapshot = id => ({ exists: !!data[id], data: () => S.copy(data[id]) });
  const db = {
    collection: () => ({ doc: id => ({ id, get: async () => snapshot(id), delete: async () => { delete data[id]; } }) }),
    runTransaction: async callback => {
      if (beforeTransaction) { beforeTransaction(); beforeTransaction = null; }
      if (fail) throw Error('write failed');
      const writes = [];
      const result = await callback({ get: async ref => snapshot(ref.id),
        set: (ref, value) => writes.push(() => { data[ref.id] = { ...data[ref.id], ...value }; }),
        delete: ref => writes.push(() => { delete data[ref.id]; }),
      });
      writes.forEach(write => write());
      return result;
    },
  };
  const context = vm.createContext({ ChargeSync: S, admin: { initializeApp() {}, credential: { cert: () => ({}) }, firestore: () => db },
    process: { env: { FIREBASE_SERVICE_ACCOUNT: '{"project_id":"test"}', GOE_SERIAL: '123456', GOE_TOKEN: 'fake' } },
    fetch: async () => ({ ok: true, json: async () => S.copy(status) }),
    console: { log() {} }, setTimeout, Intl, Date,
  });
  vm.runInContext(source, context);
  return { data, status, run: () => context.run(), before: fn => { beforeTransaction = fn; }, offline: () => { fail = true; } };
}

describe('actual importer with fake APIs', () => {
  it('imports only once on repeated polls and after reboot, then respects deletion', async () => {
    const i = importer();
    await i.run();
    await i.run();
    expect(i.data.haushalt.charges).toHaveLength(1);
    i.status.lch = 10; i.status.rbt = 500; i.status.lccfc = 400;
    await i.run();
    expect(i.data.haushalt.charges).toHaveLength(1);
    const original = i.data.haushalt.charges[0];
    i.data['charge-deletions'].entries = [S.deletionMarker(original)];
    i.data.haushalt.charges = [];
    await i.run();
    expect(i.data.haushalt.charges).toEqual([]);
    i.status.eto += 78300; i.status.lch = 20;
    await i.run();
    expect(i.data.haushalt.charges).toHaveLength(1);
    expect(i.data.haushalt.charges[0].id).not.toBe(original.id);
  });
  it('preserves a browser entry created after the initial settings read', async () => {
    const i = importer();
    i.before(() => { i.data.haushalt.charges.push({ ...newer, lch: null }); });
    await i.run();
    expect(i.data.haushalt.charges).toHaveLength(2);
  });
  it('keeps peak data when the transaction fails', async () => {
    const i = importer(); i.offline();
    await expect(i.run()).rejects.toThrow('write failed');
    expect(i.data['goe-peak-tracker'].maxW).toBe(11000);
    expect(i.data.haushalt.charges).toEqual([]);
  });
  it('does not manufacture an import timestamp from an invalid reboot-relative time', async () => {
    const i = importer(); i.status.lccfc = 11000;
    await i.run();
    expect(i.data.haushalt.charges).toEqual([]);
  });
});
