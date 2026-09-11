// go-e Auto-Import – pollt go-e Cloud API, speichert abgeschlossene Ladungen in Firestore
// V2: Energie bevorzugt aus dem geeichten Gesamtzähler (eto) statt aus wh.

import admin from 'firebase-admin';
import '../../src/charge-sync.js';
import {
  advanceImportState,
  chooseSessionEnergy,
  meterSessionKey,
  normalizeEto,
} from '../../src/goe-import-state.js';

const WIEN_TARIFFS = {
  netznutzung_arbeit:      0.0698,
  netzverlust:             0.0070,
  foerderbeitrag_arbeit:   0.00583,
  foerderbeitrag_nvl:      0.00037,
  elektrizitaetsabgabe:    0.001,
  gebrauchsabgabe_pct:     7.0,
  ust_pct:                 20.0,
  snap_rabatt:             0.20,
};

const DEFAULT_ENERGY_PRICE = 0.140118;

function isSnap(date, time, durationMs = 0) {
  if (!date || !time) return false;
  const [h, m] = time.split(':').map(Number);
  const endMin = h * 60 + (m || 0);
  const halfMin = Math.floor((durationMs || 0) / 60000 / 2);
  let checkMin = endMin - halfMin;
  const checkDate = new Date(date);
  while (checkMin < 0)        { checkMin += 24 * 60; checkDate.setDate(checkDate.getDate() - 1); }
  while (checkMin >= 24 * 60) { checkMin -= 24 * 60; checkDate.setDate(checkDate.getDate() + 1); }
  const month = checkDate.getMonth();
  if (month < 3 || month > 8) return false;
  return checkMin >= 10 * 60 && checkMin < 16 * 60;
}

function calcTotal(kwh, energyPrice, snap = false, gab_pct = WIEN_TARIFFS.gebrauchsabgabe_pct, ust_pct = WIEN_TARIFFS.ust_pct) {
  const gab = gab_pct / 100;
  const ust = ust_pct / 100;
  const netznutzung = WIEN_TARIFFS.netznutzung_arbeit * (snap ? (1 - WIEN_TARIFFS.snap_rabatt) : 1);
  const netz = netznutzung + WIEN_TARIFFS.netzverlust;
  const foerder = WIEN_TARIFFS.foerderbeitrag_arbeit + WIEN_TARIFFS.foerderbeitrag_nvl;
  const eAbgabe = WIEN_TARIFFS.elektrizitaetsabgabe;
  const gabBasis = energyPrice + netz;
  const gabPerKwh = gabBasis * gab;
  const nettoTotalPerKwh = energyPrice + netz + gabPerKwh + foerder + eAbgabe;
  const bruttoPerKwh = nettoTotalPerKwh * (1 + ust);
  return { total: Math.round(kwh * bruttoPerKwh * 100) / 100, bruttoPerKwh };
}

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount), projectId: serviceAccount.project_id });

const db = admin.firestore();
const docRef = db.collection('haushalte').doc('haushalt');
const deletedRef = db.collection('haushalte').doc('charge-deletions');
const peakRef = db.collection('haushalte').doc('goe-peak-tracker');
const importStateRef = db.collection('haushalte').doc('goe-import-state');

async function trackPeak(powerW, wh, rbt) {
  if (typeof powerW !== 'number') {
    console.log('nrg[11] nicht verfügbar – Peak-Tracking übersprungen.');
    return;
  }
  let prev = null;
  try {
    const snap = await peakRef.get();
    prev = snap.exists ? snap.data() : null;
  } catch (e) {
    console.log(`Peak-Tracker nicht lesbar (${e.message}) – starte neu.`);
  }

  const isNewSession = !prev
    || (typeof prev.wh === 'number' && wh < prev.wh)
    || (rbt !== null && typeof prev.rbt === 'number' && rbt < prev.rbt);
  const maxW = isNewSession ? powerW : Math.max(prev.maxW ?? 0, powerW);
  const samples = isNewSession ? 1 : (prev.samples ?? 0) + 1;

  await peakRef.set({ maxW, samples, wh, rbt, updatedAt: new Date().toISOString() });
  console.log(`Peak-Tracking: P=${powerW}W | max=${maxW}W (${(maxW / 1000).toFixed(2)} kW) | samples=${samples}${isNewSession ? ' | neue Session' : ''}`);
}

async function consumePeak() {
  try {
    const snap = await peakRef.get();
    return snap.exists ? snap.data() : null;
  } catch (e) {
    console.log(`Peak-Tracker nicht lesbar (${e.message}) – maxKw bleibt leer.`);
    return null;
  }
}

const OFFLINE_CODES = new Set([403, 404]);
const FETCH_TRIES = 3;
const RETRY_DELAY_MS = 5000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchStatus(url, token) {
  let last = '';
  for (let attempt = 1; attempt <= FETCH_TRIES; attempt++) {
    if (attempt > 1) await sleep(RETRY_DELAY_MS * (attempt - 1));
    let res;
    try {
      res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    } catch (e) {
      last = `Netzwerkfehler: ${e.message}`;
      console.log(`Versuch ${attempt}/${FETCH_TRIES} – ${last}`);
      continue;
    }
    if (res.ok) return await res.json();
    if (OFFLINE_CODES.has(res.status)) {
      const grund = res.status === 403
        ? 'Charger offline oder Cloud-API nicht aktiviert'
        : 'Charger online, sendet aber gerade keine Daten';
      console.log(`::warning::go-e API ${res.status}: ${grund}. Lauf übersprungen.`);
      return null;
    }
    last = `HTTP ${res.status} ${res.statusText}`;
    console.log(`Versuch ${attempt}/${FETCH_TRIES} – ${last}`);
  }
  throw new Error(`go-e API nach ${FETCH_TRIES} Versuchen nicht erreichbar (${last})`);
}

function roundKwh(energyWh) {
  return Math.round((energyWh / 1000) * 1000) / 1000;
}

async function persistStateOnly(nextState) {
  if (!nextState) return;
  await importStateRef.set(nextState);
}

async function run() {
  const serial = process.env.GOE_SERIAL;
  const token = process.env.GOE_TOKEN;
  const status = await fetchStatus(`https://${serial}.api.v3.go-e.io/api/status`, token);
  if (!status) return;

  const car = status.car;
  const wh = status.wh ?? 0;
  const lch = status.lch ?? null;
  const rbt = status.rbt ?? null;
  const lccfc = status.lccfc ?? null;
  const powerW = typeof status.nrg?.[11] === 'number' ? status.nrg[11] : null;
  const totalWh = normalizeEto(status.eto);
  const meterKey = meterSessionKey(serial, totalWh);
  const observedAt = new Date().toISOString();

  const stateSnap = await importStateRef.get();
  const previousState = stateSnap.exists ? stateSnap.data() : null;
  const transition = totalWh !== null
    ? advanceImportState(previousState, { serial, car, totalWh, observedAt })
    : { state: previousState, completed: null, reset: false };

  console.log(`car=${car} | wh=${wh} | eto=${JSON.stringify(status.eto)} | lch=${lch} | rbt=${rbt} | lccfc=${lccfc} | P=${powerW}W`);
  if (transition.reset) console.log('::warning::eto ist gefallen – Importzustand wurde sicher neu initialisiert.');

  if (car === 2) {
    await trackPeak(powerW, wh, rbt);
    await persistStateOnly(transition.state);
    return;
  }

  if (car !== 1) {
    await persistStateOnly(transition.state);
    console.log(`car=${car} – Auto verbunden, lädt aber nicht (Importzustand fortgeschrieben).`);
    return;
  }

  const peak = await consumePeak();
  const energy = chooseSessionEnergy(transition.completed, wh);
  if (!energy) {
    if (peak) await peakRef.delete();
    await persistStateOnly(transition.state);
    console.log('Keine importierbare Energiemenge – Session ignoriert.');
    return;
  }

  // Mit gültigem Zähler-Key ist lch nur Diagnose/Legacy-Fallback und kein Gate mehr.
  if (!meterKey && !lch) {
    if (peak) await peakRef.delete();
    await persistStateOnly(transition.state);
    console.log('Weder stabiler eto-Key noch lch vorhanden – Session nicht sicher identifizierbar.');
    return;
  }

  const now = new Date();
  if (!Number.isFinite(rbt) || !Number.isFinite(lccfc) || lccfc <= 0 || lccfc > rbt) {
    if (peak) await peakRef.delete();
    await persistStateOnly(transition.state);
    console.log('Kein gültiges Ladeende (z.B. nach Neustart) – kein geratener Import.');
    return;
  }

  const sessionEnd = new Date(now.getTime() - (rbt - lccfc));
  const viennaFormatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Vienna', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const [date, time] = viennaFormatter.format(sessionEnd).split(' ');
  const kwh = roundKwh(energy.energyWh);
  console.log(`sessionEnd=${sessionEnd.toISOString()} | date=${date} | time=${time} | energy=${kwh} kWh (${energy.source})`);

  const docSnap = await docRef.get();
  const data = docSnap.exists ? docSnap.data() : {};
  const fsSettings = data.settings || {};
  const energyPrice = fsSettings.defaultEnergy || DEFAULT_ENERGY_PRICE;
  const gab_pct = fsSettings.gebrauchsabgabe || WIEN_TARIFFS.gebrauchsabgabe_pct;
  const ust_pct = fsSettings.ust || WIEN_TARIFFS.ust_pct;

  const dauerMs = status.cdi?.value || 0;
  const snap = isSnap(date, time, dauerMs);
  const { total, bruttoPerKwh } = calcTotal(kwh, energyPrice, snap, gab_pct, ust_pct);
  const dauerSec = Math.floor(dauerMs / 1000);
  const h = Math.floor(dauerSec / 3600);
  const m = Math.floor((dauerSec % 3600) / 60);
  const s = dauerSec % 60;
  const dauer = dauerMs > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : null;
  const maxKw = peak && typeof peak.maxW === 'number' && peak.maxW > 0 ? Math.round(peak.maxW / 10) / 100 : null;

  if (!meterKey) console.log('::warning::eto fehlt oder ist ungültig – eingeschränkter Legacy-Abgleich über lch und Zeitpunkt.');
  const entry = {
    id: meterKey ? `goe-${serial}-${totalWh}` : Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    sessionKey: meterKey,
    sessionDate: date,
    sessionTime: time,
    date,
    time,
    snap,
    kwh,
    energyPrice,
    total,
    bruttoPerKwh,
    source: 'go-e-auto',
    energySource: energy.source,
    meterStartWh: energy.meterStartWh,
    meterEndWh: totalWh,
    lch,
    maxKw,
    dauer,
    dauerGesamt: null,
    created: new Date().toISOString(),
  };

  const imported = await db.runTransaction(async tx => {
    const doc = await tx.get(docRef);
    const deleted = await tx.get(deletedRef);
    const tracker = await tx.get(peakRef);
    const current = doc.exists ? doc.data() : {};
    const markers = deleted.exists ? deleted.data().entries || [] : [];
    const next = ChargeSync.importSession(current, markers, entry);

    if (next.changed) {
      tx.set(docRef, { charges: next.charges }, { merge: true });
      tx.set(deletedRef, { entries: next.deleted });
    }
    if (transition.state) tx.set(importStateRef, transition.state);
    if (tracker.exists) tx.delete(peakRef);
    return next.imported;
  });

  console.log(imported
    ? `✅ Gespeichert: ${date} ${time} | ${kwh} kWh (${energy.source}) | ${total} € | SNAP=${snap}`
    : `Session bereits vorhanden oder bewusst gelöscht – übersprungen (${date} ${time}).`);
}

run().catch(err => {
  console.error('Fehler:', err);
  process.exit(1);
});
