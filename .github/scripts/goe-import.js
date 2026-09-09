// go-e Auto-Import – pollt go-e Cloud API, speichert abgeschlossene Ladungen in Firestore
// Läuft als GitHub Action alle 15 min

import admin from 'firebase-admin';
import '../../src/charge-sync.js';

// =====================================================================
// WIEN_TARIFFS + calcTotal (identisch mit script.js)
// =====================================================================
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

const DEFAULT_ENERGY_PRICE = 0.140118; // €/kWh netto

// SNAP: Apr–Sep, 10:00–16:00. time = Ladeende, durationMs = aktive Ladedauer →
// es wird der Mittelpunkt der Ladezeit geprüft, damit Nachtladungen mit Abstecken
// am Vormittag nicht fälschlich den 20% Netznutzungs-Rabatt erhalten.
function isSnap(date, time, durationMs = 0) {
  if (!date || !time) return false;
  const [h, m] = time.split(':').map(Number);
  const endMin = h * 60 + (m || 0);
  const halfMin = Math.floor((durationMs || 0) / 60000 / 2);
  let checkMin = endMin - halfMin;
  const checkDate = new Date(date);
  while (checkMin < 0)        { checkMin += 24 * 60; checkDate.setDate(checkDate.getDate() - 1); }
  while (checkMin >= 24 * 60) { checkMin -= 24 * 60; checkDate.setDate(checkDate.getDate() + 1); }
  const month = checkDate.getMonth(); // 0=Jan
  if (month < 3 || month > 8) return false; // Apr–Sep
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
  const total = kwh * bruttoPerKwh;
  return { total: Math.round(total * 100) / 100, bruttoPerKwh };
}

// =====================================================================
// FIREBASE INIT
// =====================================================================
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: serviceAccount.project_id,
});

const db = admin.firestore();
const docRef = db.collection('haushalte').doc('haushalt');
const deletedRef = db.collection('haushalte').doc('charge-deletions');

// Peak-Tracker bewusst als EIGENES Dokument, nicht als Feld in 'haushalt':
// Unabhängig vom Haushalt-Sync; alte Browser-Versionen ersetzen dessen Dokument.
const peakRef = db.collection('haushalte').doc('goe-peak-tracker');

// =====================================================================
// PEAK-TRACKER
// Der Workflow pollt alle 15 min – also im selben Raster, in dem ab 2027 auch
// die Verrechnungsleistung ermittelt wird. Der so gewonnene Wert ist ein
// ABGETASTETES Maximum: eine kurze Spitze zwischen zwei Läufen wird nicht
// gesehen. Für die Frage „hängt die Wallbox dauerhaft nahe 11 kW?" reicht das,
// weil die Ladeleistung über weite Teile der Session konstant ist.
// =====================================================================
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

  // Neue Session erkennen: wh zählt pro Session hoch, ein Rückgang bedeutet
  // Reset. rbt kleiner als zuvor = Wallbox-Reboot.
  const isNewSession = !prev
    || (typeof prev.wh === 'number' && wh < prev.wh)
    || (rbt !== null && typeof prev.rbt === 'number' && rbt < prev.rbt);

  const maxW = isNewSession ? powerW : Math.max(prev.maxW ?? 0, powerW);
  const samples = isNewSession ? 1 : (prev.samples ?? 0) + 1;

  await peakRef.set({ maxW, samples, wh, rbt, updatedAt: new Date().toISOString() });
  console.log(
    `Peak-Tracking: P=${powerW}W | max=${maxW}W (${(maxW / 1000).toFixed(2)} kW) | ` +
    `samples=${samples}${isNewSession ? ' | neue Session' : ''}`
  );
}

// Liest den Peak. Erst die erfolgreiche Import-Transaktion löscht den Tracker.
async function consumePeak() {
  try {
    const snap = await peakRef.get();
    if (!snap.exists) return null;
    const data = snap.data();
    return data;
  } catch (e) {
    console.log(`Peak-Tracker nicht lesbar (${e.message}) – maxKw bleibt leer.`);
    return null;
  }
}

// =====================================================================
// GO-E CLOUD API
// Statuscodes laut cloudapi-de.md:
//   200 – Daten liegen vor
//   403 – Charger ist offline ODER die Cloud-API ist nicht aktiviert
//   404 – Auth war korrekt, der Charger sendet gerade keine Daten
//
// 403/404 sind Betriebszustände, keine Defekte: eine Wallbox ohne Strom oder
// WLAN ist der Normalfall, und beim nächsten Lauf ist alles wieder da – die
// Session bleibt in `wh`/`lch` stehen, bis eine neue beginnt, und der
// Zeitstempel kommt aus `now - (rbt - lccfc)`, bleibt also auch nach Stunden
// Ausfall korrekt. Solche Läufe dürfen den Job nicht rot färben, sonst steht
// die Action dauerhaft auf Fehler und ein echter Defekt fällt nicht mehr auf.
// Rot bleibt, was wirklich kaputt ist: 5xx, Netzwerkfehler, unlesbare Antwort.
//
// Sichtbar bleibt der Zustand trotzdem: `::warning::` hängt eine Annotation an
// den grünen Run. Das ist wichtig, weil 403 eben auch „Cloud-API in der App
// abgedreht" heißen kann – ein Zustand, der von allein nie wieder weggeht.
//
// Was ein Ausfall trotzdem kostet: der Peak-Tracker tastet `nrg[11]` nur bei
// `car === 2` ab. Offline-Zeit während einer laufenden Ladung fehlt in `maxKw`.
// =====================================================================
const OFFLINE_CODES  = new Set([403, 404]);
const FETCH_TRIES    = 3;
const RETRY_DELAY_MS = 5000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// → Status-Objekt, oder null wenn der Charger offline/stumm ist.
// Wirft nur bei echten Fehlern (dann exit 1 über run().catch).
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

    // Offline/stumm: kein Retry, das ändert sich nicht in 5 Sekunden.
    if (OFFLINE_CODES.has(res.status)) {
      const grund = res.status === 403
        ? 'Charger offline oder Cloud-API nicht aktiviert (App → Internet → Erweiterte Einstellungen bzw. api key "cae")'
        : 'Charger online, sendet aber gerade keine Daten';
      console.log(`::warning::go-e API ${res.status}: ${grund}. Lauf übersprungen, kein Datenverlust.`);
      return null;
    }

    last = `HTTP ${res.status} ${res.statusText}`;
    console.log(`Versuch ${attempt}/${FETCH_TRIES} – ${last}`);
  }

  throw new Error(`go-e API nach ${FETCH_TRIES} Versuchen nicht erreichbar (${last})`);
}

// =====================================================================
// MAIN
// =====================================================================
async function run() {
  // 1. go-e API abfragen
  const serial = process.env.GOE_SERIAL;
  const token  = process.env.GOE_TOKEN;
  const url = `https://${serial}.api.v3.go-e.io/api/status`;

  const status = await fetchStatus(url, token);
  if (!status) return; // offline/stumm – nichts zu tun, aber kein Fehler

  // 2. Relevante Felder loggen
  const car   = status.car;
  const wh    = status.wh    ?? 0;
  const lch   = status.lch   ?? null; // ms seit Boot – Session-ID
  const rbt   = status.rbt   ?? null; // ms seit Boot (aktuell)
  const lccfc = status.lccfc ?? null; // ms seit Boot: lastCarStateChangedFromCharging
  const powerW = typeof status.nrg?.[11] === 'number' ? status.nrg[11] : null; // momentane Gesamtleistung
  console.log(`car=${car} | wh=${wh} | lch=${lch} | rbt=${rbt} | lccfc=${lccfc} | P=${powerW}W`);

  // 2b. Peak-Tracking während der Ladung (car==2).
  // nrg[11] ist die MOMENTANE Leistung, kein Session-Maximum. Beim Import selbst
  // (car==1, abgesteckt) fliesst nichts mehr – dort ist der Wert immer 0. Der Peak
  // muss deshalb laufend mitgeschrieben werden, solange tatsächlich geladen wird.
  if (car === 2) {
    await trackPeak(powerW, wh, rbt);
    return;
  }

  // 3. Neue Session erkennen: car==1 (idle/abgesteckt) + wh > 0 + lch neu
  if (car !== 1) {
    console.log(`car=${car} – Auto verbunden, lädt aber nicht (Peak bleibt erhalten).`);
    return;
  }

  // Peak für den Import lesen; bei Fehlern bleibt er für den nächsten Lauf erhalten.
  const peak = await consumePeak();

  if (wh < 10) {
    await peakRef.delete();
    console.log(`wh=${wh} zu gering – ignoriert.`);
    return;
  }

  if (!lch) {
    console.log('Kein lch-Wert vorhanden – ignoriert.');
    return;
  }

  // kWh auf 3 Dezimalstellen runden
  const kwh = Math.round((wh / 1000) * 1000) / 1000;

  // 4. Firestore: bestehende Daten + Settings lesen
  const docSnap = await docRef.get();
  const data = docSnap.exists ? docSnap.data() : {};
  const fsSettings = data.settings || {};
  const energyPrice  = fsSettings.defaultEnergy     || DEFAULT_ENERGY_PRICE;
  const gab_pct      = fsSettings.gebrauchsabgabe   || WIEN_TARIFFS.gebrauchsabgabe_pct;
  const ust_pct      = fsSettings.ust               || WIEN_TARIFFS.ust_pct;
  console.log(`settings: energyPrice=${energyPrice} | gab=${gab_pct}% | ust=${ust_pct}%`);

  // Datum/Uhrzeit: exakter Session-Endzeitpunkt via rbt + lccfc
  // lccfc = ms seit Boot als die Ladung endete → now - (rbt - lccfc) = echter Endzeitpunkt
  const now = new Date();
  if (!Number.isFinite(rbt) || !Number.isFinite(lccfc) || lccfc < 0 || lccfc > rbt) {
    console.log('::warning::Kein gültiges Ladeende (z.B. nach Neustart) – kein geratener Import.');
    return;
  }
  const sessionEnd = new Date(now.getTime() - (rbt - lccfc));
  const viennaFormatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Vienna',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
  const [date, time] = viennaFormatter.format(sessionEnd).split(' ');
  // date = YYYY-MM-DD, time = HH:MM
  console.log(`sessionEnd=${sessionEnd.toISOString()} | date=${date} | time=${time}`);

  // 5. Kosten berechnen mit Settings aus Firestore inkl. SNAP-Erkennung
  // SNAP wird über den Mittelpunkt der aktiven Ladezeit geprüft (dauerMs aus cdi)
  const dauerMs = status.cdi?.value || 0;
  const snap = isSnap(date, time, dauerMs);
  const r = calcTotal(kwh, energyPrice, snap, gab_pct, ust_pct);
  const { total, bruttoPerKwh } = r;

  const dauerSec = Math.floor(dauerMs / 1000);
  const h = Math.floor(dauerSec / 3600);
  const m = Math.floor((dauerSec % 3600) / 60);
  const s = dauerSec % 60;
  const dauer = dauerMs > 0
    ? (h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0'))
    : null;
  // maxKw aus dem Peak-Tracker. Kein Fallback auf nrg[11]: hier ist car==1, es
  // fliesst nichts mehr, der Wert wäre immer 0 – und 0 ist kein Maximum, sondern
  // eine Lüge. Ohne Tracking-Daten bleibt das Feld leer.
  const maxKw = (peak && typeof peak.maxW === 'number' && peak.maxW > 0)
    ? Math.round(peak.maxW / 10) / 100
    : null;
  console.log(`maxKw=${maxKw ?? '—'} (aus ${peak?.samples ?? 0} Messpunkten)`);

  const entry = {
    // Cumulative Wh survives reboot; equal amounts in two real sessions have
    // different meter endpoints. Never use kWh alone as a session identity.
    id:           Number.isFinite(status.eto) && status.eto > 0
      ? `goe-${serial}-${status.eto}`
      : Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    sessionKey:   Number.isFinite(status.eto) && status.eto > 0 ? `goe:${serial}:${status.eto}` : null,
    sessionDate:  date,
    sessionTime:  time,
    date,
    time,
    snap,
    kwh,
    energyPrice,
    total,
    bruttoPerKwh,
    source:       'go-e-auto',
    lch,
    maxKw,
    dauer,
    dauerGesamt:  null,
    created:      new Date().toISOString(),
  };

  // Re-read inside the transaction: browser edits/deletions and overlapping
  // imports must never be overwritten by the earlier settings read.
  const imported = await db.runTransaction(async tx => {
    const doc = await tx.get(docRef);
    const deleted = await tx.get(deletedRef);
    const current = doc.exists ? doc.data() : {};
    const markers = deleted.exists ? deleted.data().entries || [] : [];
    const next = ChargeSync.importSession(current, markers, entry);
    tx.set(docRef, { charges: next.charges }, { merge: true });
    tx.set(deletedRef, { entries: next.deleted });
    // Only consume after a successful import/known-session check, not before
    // a failed household write. Workflow concurrency protects this tracker.
    tx.delete(peakRef);
    return next.imported;
  });
  console.log(imported
    ? `✅ Gespeichert: ${date} ${time} | ${kwh} kWh | ${total} € | SNAP=${snap}`
    : `Session bereits vorhanden oder bewusst gelöscht – übersprungen (${date} ${time}).`);

}

run().catch(err => {
  console.error('Fehler:', err);
  process.exit(1);
});
