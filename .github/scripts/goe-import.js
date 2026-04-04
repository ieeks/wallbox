// go-e Auto-Import – pollt go-e Cloud API, speichert abgeschlossene Ladungen in Firestore
// Läuft als GitHub Action alle 15 min

import admin from 'firebase-admin';

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

function isSnap(date, time) {
  if (!date || !time) return false;
  const month = new Date(date).getMonth(); // 0=Jan
  if (month < 3 || month > 8) return false; // Apr–Sep
  const [h, m] = time.split(':').map(Number);
  const minutes = h * 60 + (m || 0);
  return minutes >= 10 * 60 && minutes < 16 * 60;
}

function calcTotal(kwh, energyPrice, snap = false) {
  const gab = WIEN_TARIFFS.gebrauchsabgabe_pct / 100;
  const ust = WIEN_TARIFFS.ust_pct / 100;
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

// Millisekunden → "H:MM:SS"
function msToHMS(ms) {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
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

// =====================================================================
// MAIN
// =====================================================================
async function run() {
  // 1. go-e API abfragen
  const serial = process.env.GOE_SERIAL;
  const token  = process.env.GOE_TOKEN;
  const url = `https://${serial}.api.v3.go-e.io/api/status`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    console.log(`go-e API Fehler: ${res.status} ${res.statusText}`);
    process.exit(1);
  }

  const status = await res.json();

  // 2. Nur speichern wenn Ladung abgeschlossen (car === 4)
  if (status.car !== 4) {
    console.log(`Status car=${status.car} – keine abgeschlossene Ladung, nichts zu tun.`);
    return;
  }

  const wh  = status.wh  ?? 0;
  const cdi = status.cdi ?? 0; // Ladedauer in ms (aktiver Stromfluss)

  if (wh < 10) {
    console.log(`wh=${wh} zu gering – ignoriert.`);
    return;
  }

  const kwh = Math.round((wh / 1000) * 1000) / 1000;

  // Ladezeit für Datum/Uhrzeit: jetzt minus Ladedauer
  const endTime   = new Date();
  const startTime = new Date(endTime.getTime() - cdi);

  const date = startTime.toISOString().slice(0, 10); // YYYY-MM-DD
  const time = startTime.toTimeString().slice(0, 5);  // HH:MM

  // 3. Firestore: bestehende Charges lesen
  const snap = isSnap(date, time);
  const docSnap = await docRef.get();
  const existing = docSnap.exists ? (docSnap.data().charges || []) : [];

  // Duplikat-Check: selbes Datum + ähnliche kWh (±0.05)
  const duplicate = existing.some(c => c.date === date && Math.abs(c.kwh - kwh) < 0.05);
  if (duplicate) {
    console.log(`Duplikat erkannt: ${date} ${kwh} kWh – bereits gespeichert.`);
    return;
  }

  // 4. Kosten berechnen
  const r = calcTotal(kwh, DEFAULT_ENERGY_PRICE, snap);

  const dauer      = msToHMS(cdi);          // aktiver Stromfluss (cdi)
  const maxKw      = typeof status.nrg?.[11] === 'number' ? status.nrg[11] / 1000 : null;

  const entry = {
    id:           Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    date,
    time,
    snap,
    kwh,
    energyPrice:  DEFAULT_ENERGY_PRICE,
    total:        r.total,
    bruttoPerKwh: r.bruttoPerKwh,
    source:       'go-e-auto',
    maxKw,
    dauer,          // aktive Ladezeit
    dauerGesamt:  null, // nicht aus API verfügbar
    created:      new Date().toISOString(),
  };

  // 5. In Firestore speichern (ans Array anhängen, nach Datum sortieren)
  const updated = [entry, ...existing].sort((a, b) => b.date.localeCompare(a.date));
  await docRef.set({ charges: updated }, { merge: true });

  console.log(`✅ Gespeichert: ${date} ${kwh} kWh → ${r.total} € (SNAP: ${snap})`);
}

run().catch(err => {
  console.error('Fehler:', err);
  process.exit(1);
});
