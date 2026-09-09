import { describe, it, expect } from 'vitest';
import './charge-sync.js';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const S = globalThis.ChargeSync;
function cut(source, from, to) {
  const start = source.indexOf(from), end = source.indexOf(to, start + from.length);
  if (start < 0 || end < 0 || end <= start) throw Error('Test-Quelltextmarke fehlt: ' + from);
  return source.slice(start, end);
}
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
    collection: () => ({ doc: id => {
      const key = id === 'haushalt' ? 'household' : 'deleted';
      return { id: key, set: async (value, options) => {
        expect(options).toEqual({ mergeFields: ['settings'] });
        dbData[key].settings = S.copy(value.settings);
      } };
    } }),
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
  const context = vm.createContext({ ChargeSync: S, db, firebaseReady: true,
    HOUSEHOLD_DOC: 'haushalt', charges: S.copy(initial.charges), settings: S.copy(initial.settings),
    firebase: { firestore: { FieldValue: { serverTimestamp: () => 1 } } },
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
    startupStorageError: null, console: { error() {} },
    document: { getElementById: () => ({ hidden: true, textContent: '' }) },
    setSyncStatus: status => events.push(status), refreshDashboard() {}, showToast() {},
    location: { reload: () => events.push('reload') },
  });
  vm.runInContext(cut(source, 'const SYNC_OUTBOX', '// =====================================================================\n// AUFKLAPPBARE'), context);
  vm.runInContext(cut(source, 'async function syncToCloud()', '\nfunction deduplicateCharges'), context);
  vm.runInContext(cut(source, 'async function clearAllData()', '// Einträge mit `dauer`'), context);
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
    expect(b.events.at(-1)).toBe('error');
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
  const counts = { writes: 0, deletes: 0 };
  const snapshot = id => ({ exists: !!data[id], data: () => S.copy(data[id]) });
  const db = {
    collection: () => ({ doc: id => ({ id, get: async () => snapshot(id), delete: async () => { delete data[id]; } }) }),
    runTransaction: async callback => {
      if (beforeTransaction) { beforeTransaction(); beforeTransaction = null; }
      if (fail) throw Error('write failed');
      const writes = [];
      const result = await callback({ get: async ref => snapshot(ref.id),
        set: (ref, value) => writes.push(() => { counts.writes++; data[ref.id] = { ...data[ref.id], ...value }; }),
        delete: ref => writes.push(() => { counts.deletes++; delete data[ref.id]; }),
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
  return { data, status, counts, run: () => context.run(), before: fn => { beforeTransaction = fn; }, offline: () => { fail = true; } };
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

describe('review regressions', () => {
  it('rejects ID-less data before it can collapse into a Map or be written', async () => {
    const bad = [{ date: '2026-01-02', kwh: 1 }, { date: '2026-01-01', kwh: 2 }];
    expect(() => S.apply(state(bad), [], [])).toThrow('ID');
    const b = browser();
    b.dbData.household.charges = S.copy(bad);
    expect(await b.sync()).toBe(false);
    expect(b.dbData.household.charges).toEqual(bad);
    expect(b.events.at(-1)).toBe('error');
  });
  it('keeps ID-less entries when explicitly looking for duplicates', () => {
    const context = vm.createContext({ ChargeSync: S });
    const source = readFileSync(new URL('../script.js', import.meta.url), 'utf8');
    vm.runInContext(cut(source, 'function deduplicateCharges', 'async function loadFromCloud'), context);
    expect(context.deduplicateCharges([{ date: a.date }, { date: a.date }])).toHaveLength(2);
  });
  it('starts without crypto.randomUUID and generates distinct operations', async () => {
    const b = browser(); // no crypto in this context
    expect(b.context.crypto).toBeUndefined();
    b.context.settings.theme = 'dark';
    b.context.captureSyncChanges();
    const ops = JSON.parse(b.storage.get('lf_charge_outbox'));
    expect(new Set(ops.map(op => op.opId)).size).toBe(ops.length);
    expect(await b.sync()).toBe(true);
  });
  it('does not crash startup or discard data when localStorage rejects writes', async () => {
    class FullStorage extends Map { set() { throw new Error('QuotaExceededError'); } }
    const b = browser(state(), new FullStorage());
    expect(await b.sync()).toBe(false);
    expect(b.context.charges).toEqual([a]);
    expect(b.dbData.household.charges).toEqual([a]);
    expect(b.events.at(-1)).toBe('error');
  });
  it('preserves malformed pending data and visibly stops sync instead of resetting to []', async () => {
    for (const raw of ['{broken', '{"not":"an array"}']) {
      const storage = new Map([['lf_charge_outbox', raw]]);
      const b = browser(state(), storage);
      expect(await b.sync()).toBe(false);
      expect(storage.get('lf_charge_outbox')).toBe(raw);
      expect(b.context.charges).toEqual([a]);
    }
  });
  it('resets settings and charges while preserving deletion markers and trips', async () => {
    const b = browser();
    b.storage.set('lf_trips', '[{"id":"holiday"}]');
    await b.sync();
    await b.context.clearAllData();
    expect(b.dbData.household.settings).toEqual({});
    expect(b.dbData.household.charges).toEqual([]);
    expect(b.dbData.deleted.entries[0].id).toBe('a');
    expect(b.storage.has('lf_settings')).toBe(false);
    expect(b.storage.get('lf_trips')).toBe('[{"id":"holiday"}]');
    expect(b.events.at(-1)).toBe('reload');
  });
  it('normalizes undefined field updates to Firestore-compatible null', () => {
    const ops = S.changes(state([{ ...a, dauer: '1:00:00' }]), state([{ ...a, dauer: undefined }]));
    expect(S.apply(state([{ ...a, dauer: '1:00:00' }]), [], ops).charges[0].dauer).toBe(null);
  });
  it('does not produce operations from reordered object keys', () => {
    expect(S.changes(state(), state([{ total: a.total, kwh: a.kwh, time: a.time, date: a.date, lch: a.lch, id: a.id }]))).toEqual([]);
  });
  it('fails loudly when a source extraction marker is renamed', () => {
    expect(() => cut('a b c', 'missing', 'c')).toThrow('Quelltextmarke');
  });
  it('does not write again on subsequent polls of an already enriched idle session', async () => {
    const i = importer();
    await i.run();
    const previous = { ...i.counts };
    await i.run();
    await i.run();
    expect(i.counts).toEqual(previous);
  });
  it.each([{ lch: null }, { lccfc: 0 }, { lccfc: 11000 }])('clears stale peak on terminal invalid session: %j', async overrides => {
    const i = importer(); Object.assign(i.status, overrides);
    await i.run();
    expect(i.data['goe-peak-tracker']).toBeUndefined();
    expect(i.data.haushalt.charges).toEqual([]);
  });
  it('uses a numeric-string meter endpoint without losing stable identity', async () => {
    const i = importer(); i.status.eto = '200000';
    await i.run();
    expect(i.data.haushalt.charges[0].sessionKey).toBe('goe:123456:200000');
  });
});


it('shows missing Firestore permissions as a blocked sync and keeps the outbox', async () => {
  const b = browser();
  const notice = {};
  b.context.document.getElementById = () => notice;
  b.context.db.runTransaction = async () => { throw Object.assign(new Error('denied'), { code: 'permission-denied' }); };
  expect(await b.sync()).toBe(false);
  expect(notice.hidden).toBe(false);
  expect(notice.textContent).toContain('Zugriffsrechte');
  expect(JSON.parse(b.storage.get('lf_charge_outbox')).length).toBeGreaterThan(0);
  expect(b.dbData.household.charges).toEqual([a]);
});
