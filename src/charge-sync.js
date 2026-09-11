// Gemeinsame Sync-Logik für Browser und Node-Importer, ohne Build-Schritt.
(() => {
  // undefined ist kein Firestore-Wert: explizit als null normalisieren.
  const copy = value => value === undefined ? null : JSON.parse(JSON.stringify(value));
  const canonical = value => value && typeof value === 'object'
    ? (Array.isArray(value) ? value.map(canonical) : Object.fromEntries(
      Object.keys(value).sort().map(key => [key, canonical(value[key])])) ) : value;
  const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

  function assertIds(entries) {
    if (!Array.isArray(entries) || entries.some(c => !c || typeof c.id !== 'string' || !c.id)) {
      const error = new Error('Ladungsdaten enthalten Einträge ohne gültige ID. Sync zum Schutz der Daten gestoppt.');
      error.code = 'invalid-charge-state';
      throw error;
    }
  }

  function sameSession(a, b) {
    // Der geeichte Zähler-Endstand ist die stärkste Identität. Sind auf beiden
    // Seiten sessionKeys vorhanden, entscheidet ausschließlich dieser Vergleich.
    if (a.sessionKey && b.sessionKey) return a.sessionKey === b.sessionKey;
    // Der Export-Identifier ist die zweite stabile Ebene für CSV-/Legacy-Daten.
    if (a.goeSessionId && b.goeSessionId) return a.goeSessionId === b.goeSessionId;
    // Legacy-lch ist boot-relativ, nicht global eindeutig. Nie allein vergleichen.
    // Ursprünglichen lokalen Zeitpunkt auf beiden Seiten nutzen, auch nach manuellen Änderungen.
    const legacyTime = c => Date.parse(`${c.sessionDate || c.date}T${c.sessionTime || c.time || ''}:00Z`);
    return a.lch != null && b.lch != null && a.lch === b.lch
      && Math.abs(legacyTime(a) - legacyTime(b)) <= 5 * 60000;
  }

  function deletionMarker(c) {
    const marker = { id: c.id };
    for (const key of ['lch', 'sessionKey', 'goeSessionId', 'sessionDate', 'sessionTime', 'date', 'time']) {
      if (c[key] != null) marker[key] = c[key];
    }
    return marker;
  }

  function changes(before, after) {
    assertIds(before.charges);
    assertIds(after.charges);
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
    // Settings-Felder werden derzeit nur gesetzt, nicht entfernt; Reset ist ein eigener Schreibvorgang.
    const patch = {};
    for (const [key, value] of Object.entries(after.settings)) {
      if (!equal(before.settings[key], value)) patch[key] = copy(value);
    }
    if (Object.keys(patch).length) ops.push({ type: 'settings', value: patch });
    return ops;
  }

  function apply(cloud = {}, markers = [], ops = []) {
    assertIds(cloud.charges || []);
    assertIds(markers);
    assertIds(ops.filter(op => op.type !== 'settings').map(op => op.entry));
    const deleted = new Map(markers.map(c => [c.id, copy(c)]));
    const entries = new Map((cloud.charges || []).map(c => [c.id, copy(c)]));
    const settings = copy(cloud.settings || {});
    for (const op of ops) {
      if (op.type === 'settings') { Object.assign(settings, op.value); continue; }
      const c = op.entry;
      if (op.type === 'remove') {
        // Aktuelle Cloud-Kennung mitnehmen: ein Legacy-Eintrag kann inzwischen ergänzt worden sein.
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
    // Nur die gelöschte ID entfernen. Beim Löschen eines Duplikats muss das Original bleiben.
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
      // ID und manuelle Änderungen behalten; nur tatsächlich vorhandene stabile
      // Import-Kennungen ergänzen. Fehlende optionale Felder nicht als null
      // materialisieren – sonst würde jeder bekannte Idle-Poll erneut schreiben.
      if (entry.sessionKey && !match.sessionKey) match.sessionKey = entry.sessionKey;
      if (entry.goeSessionId && !match.goeSessionId) match.goeSessionId = entry.goeSessionId;
      if (!match.sessionDate && entry.sessionDate) match.sessionDate = entry.sessionDate;
      if (!match.sessionTime && entry.sessionTime) match.sessionTime = entry.sessionTime;
      return { ...current, imported: false,
        changed: !equal(current.charges, cloud.charges || []) || !equal(current.deleted, markers) };
    }
    const deletedMatch = current.deleted.find(c => c.id === entry.id || sameSession(c, entry));
    if (deletedMatch) {
      // Auch Legacy-Löschmarker ergänzen, damit ein späterer Reboot keinen Reimport auslöst.
      if (entry.sessionKey) deletedMatch.sessionKey = entry.sessionKey;
      if (entry.goeSessionId) deletedMatch.goeSessionId = entry.goeSessionId;
      return { ...current, imported: false,
        changed: !equal(current.charges, cloud.charges || []) || !equal(current.deleted, markers) };
    }
    return { ...apply(current, markers, [{ type: 'put', entry }]), imported: true, changed: true };
  }

  globalThis.ChargeSync = { copy, equal, assertIds, sameSession, deletionMarker, changes, apply, importSession };
})();
