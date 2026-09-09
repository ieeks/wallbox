// Shared by the classic browser script and the Node importer. No build required.
(() => {
  const copy = value => JSON.parse(JSON.stringify(value));
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  function sameSession(a, b) {
    if (a.sessionKey && b.sessionKey) return a.sessionKey === b.sessionKey;
    // Legacy lch is boot-relative, not globally unique. Never compare it alone.
    // Compare original local date/time on both sides, even after manual edits.
    const legacyTime = c => Date.parse(`${c.sessionDate || c.date}T${c.sessionTime || c.time || ''}:00Z`);
    return a.lch != null && b.lch != null && a.lch === b.lch
      && Math.abs(legacyTime(a) - legacyTime(b)) <= 5 * 60000;
  }

  function deletionMarker(c) {
    const marker = { id: c.id };
    for (const key of ['lch', 'sessionKey', 'sessionDate', 'sessionTime', 'date', 'time']) {
      if (c[key] != null) marker[key] = c[key];
    }
    return marker;
  }

  function changes(before, after) {
    const old = new Map(before.charges.map(c => [c.id, c]));
    const next = new Set(after.charges.map(c => c.id));
    const ops = [];
    for (const c of before.charges) {
      if (!next.has(c.id)) ops.push({ type: 'remove', entry: deletionMarker(c) });
    }
    for (const c of after.charges) {
      if (!equal(old.get(c.id), c)) {
        const patch = {};
        for (const [key, value] of Object.entries(c)) {
          if (!equal(old.get(c.id)?.[key], value)) patch[key] = copy(value);
        }
        ops.push({ type: 'put', entry: copy(c), patch });
      }
    }
    const patch = {};
    for (const [key, value] of Object.entries(after.settings)) {
      if (!equal(before.settings[key], value)) patch[key] = copy(value);
    }
    if (Object.keys(patch).length) ops.push({ type: 'settings', value: patch });
    return ops;
  }

  function apply(cloud = {}, markers = [], ops = []) {
    const deleted = new Map(markers.map(c => [c.id, c]));
    const entries = new Map((cloud.charges || []).map(c => [c.id, copy(c)]));
    const settings = copy(cloud.settings || {});
    for (const op of ops) {
      if (op.type === 'settings') { Object.assign(settings, op.value); continue; }
      const c = op.entry;
      if (op.type === 'remove') {
        // Use current cloud identity as well (a legacy entry may have been enriched).
        deleted.set(c.id, { ...deletionMarker(entries.get(c.id) || c), ...c });
        entries.delete(c.id);
      } else if (!deleted.has(c.id)) {
        if (entries.has(c.id)) {
          if (op.type === 'put') entries.set(c.id, { ...entries.get(c.id), ...copy(op.patch || c) });
        } else if (!Array.from(deleted.values()).some(d => sameSession(d, c))
          && !Array.from(entries.values()).some(e => sameSession(e, c))) {
          entries.set(c.id, copy(c));
        }
      }
    }
    // A deletion only removes its ID. Deleting a duplicate must keep the original.
    for (const id of deleted.keys()) entries.delete(id);
    return {
      charges: [...entries.values()].sort((a, b) => b.date.localeCompare(a.date)),
      settings,
      deleted: [...deleted.values()],
    };
  }

  function importSession(cloud, markers, entry) {
    const current = apply(cloud, markers);
    const match = current.charges.find(c => sameSession(c, entry));
    if (match) {
      // Retain the ID and any manual edits; only add stable import identity.
      Object.assign(match, {
        sessionKey: entry.sessionKey || match.sessionKey || null,
        sessionDate: match.sessionDate || entry.sessionDate,
        sessionTime: match.sessionTime || entry.sessionTime,
      });
      return { ...current, imported: false };
    }
    const deletedMatch = current.deleted.find(c => c.id === entry.id || sameSession(c, entry));
    if (deletedMatch) {
      // Upgrade legacy tombstones as well, so a later reboot cannot re-import them.
      if (entry.sessionKey) deletedMatch.sessionKey = entry.sessionKey;
      return { ...current, imported: false };
    }
    return { ...apply(current, markers, [{ type: 'put', entry }]), imported: true };
  }

  globalThis.ChargeSync = { copy, equal, sameSession, deletionMarker, changes, apply, importSession };
})();
