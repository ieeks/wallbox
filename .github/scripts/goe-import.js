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

  // 2. Relevante Felder loggen
  const car   = status.car;
  const wh    = status.wh    ?? 0;
  const lch   = status.lch   ?? null; // ms seit Boot – Session-ID
  const rbt   = status.rbt   ?? null; // ms seit Boot (aktuell)
  const lccfc = status.lccfc ?? null; // ms seit Boot: lastCarStateChangedFromCharging
  console.log(`car=${car} | wh=${wh} | lch=${lch} | rbt=${rbt} | lccfc=${lccfc}`);

  // 3. Neue Session erkennen: car==1 (idle/abgesteckt) + wh > 0 + lch neu
  if (car !== 1) {
    console.log(`car=${car} – Auto lädt noch oder nicht verbunden, nichts zu tun.`);
    return;
  }

  if (wh < 10) {
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
  const existing = data.charges || [];
  const fsSettings = data.settings || {};
  const energyPrice  = fsSettings.defaultEnergy     || DEFAULT_ENERGY_PRICE;
  const gab_pct      = fsSettings.gebrauchsabgabe   || WIEN_TARIFFS.gebrauchsabgabe_pct;
  const ust_pct      = fsSettings.ust               || WIEN_TARIFFS.ust_pct;
  console.log(`settings: energyPrice=${energyPrice} | gab=${gab_pct}% | ust=${ust_pct}%`);

  // Duplikat-Check: lch in bestehenden charges suchen
  // Wenn Eintrag gelöscht wurde, ist lch nicht mehr in charges → wird neu importiert
  if (existing.some(c => c.lch === lch)) {
    console.log(`Session bereits in charges: lch=${lch} – übersprungen.`);
    return;
  }

  // Datum/Uhrzeit: exakter Session-Endzeitpunkt via rbt + lccfc
  // lccfc = ms seit Boot als die Ladung endete → now - (rbt - lccfc) = echter Endzeitpunkt
  const now = new Date();
  const sessionEnd = (rbt !== null && lccfc !== null)
    ? new Date(now.getTime() - (rbt - lccfc))
    : now;
  const viennaFormatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Vienna',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
  const [date, time] = viennaFormatter.format(sessionEnd).split(' ');
  // date = YYYY-MM-DD, time = HH:MM
  console.log(`sessionEnd=${sessionEnd.toISOString()} | date=${date} | time=${time}`);

  // 5. Kosten berechnen mit Settings aus Firestore inkl. SNAP-Erkennung
  const snap = isSnap(date, time);
  const r = calcTotal(kwh, energyPrice, false, gab_pct, ust_pct);
  const { total, bruttoPerKwh } = r;

  const cdi = status.cdi ?? 0;
  const dauer  = cdi > 0 ? msToHMS(cdi) : null;
  const maxKw  = typeof status.nrg?.[11] === 'number' ? status.nrg[11] / 1000 : null;

  const entry = {
    id:           Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
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

  // 6. In Firestore speichern
  const updated = [entry, ...existing].sort((a, b) => b.date.localeCompare(a.date));
  await docRef.set({ charges: updated }, { merge: true });

  console.log(`✅ Gespeichert: ${date} ${time} | ${kwh} kWh | ${total} € | bruttoPerKwh=${bruttoPerKwh} | SNAP=${snap}`);
}

run().catch(err => {
  console.error('Fehler:', err);
  process.exit(1);
});
