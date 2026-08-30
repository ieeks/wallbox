// =====================================================================
// TRIP-PERSISTENZ
// =====================================================================
// Trips liegen in der Sub-Collection `haushalte/haushalt/trips`, ein
// Dokument je Trip – und ausdrücklich NICHT als Feld am Haushalt-Dokument:
// `syncToCloud()` schreibt dort mit `.set()` ohne `{merge:true}` und würde
// jedes der App unbekannte Feld beim nächsten Nutzer-Sync löschen (derselbe
// Grund, aus dem der go-e-Peak-Tracker ein eigenes Dokument hat).
//
// Sub-Collections sind von `.set()` am Elterndokument nicht betroffen. Der
// Preis dafür: laden und schreiben passiert hier eigenständig, nicht über
// `persist()`.
// =====================================================================
import { emptyTrip } from './model.js';

const LS_KEY = 'lf_trips';

// Zugriff auf die Globals des klassischen script.js. Die Brücke wird in
// index.html gesetzt; `charges`/`settings`/`db` sind dort mit `let`/`const`
// deklariert und stehen deshalb nicht von selbst auf `window`.
export function lf() {
  return window.lfBridge || {};
}

let trips = readLocal();
let loaded = false;

function readLocal() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch (e) {
    return [];
  }
}

function writeLocal() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(trips)); }
  catch (e) { /* Safari Private Mode */ }
}

// Firestore lehnt `undefined` ab. Der JSON-Umweg wirft es raus und nimmt
// gleich Funktionen und Zyklen mit.
function sanitize(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function collection() {
  const { db, firebaseReady, HOUSEHOLD_DOC } = lf();
  if (!firebaseReady || !db) return null;
  return db.collection('haushalte').doc(HOUSEHOLD_DOC).collection('trips');
}

export function getTrips() {
  return [...trips].sort((a, b) => (b.dateStart || '').localeCompare(a.dateStart || ''));
}

export function getTrip(id) {
  return trips.find(t => t.id === id) || null;
}

export function isLoaded() {
  return loaded;
}

// Erst beim Öffnen der Trip-Ansicht laden – der Ladefuchs-Start soll davon
// nichts merken.
export async function loadTrips() {
  const col = collection();
  if (!col) { loaded = true; return getTrips(); }

  try {
    const snap = await col.get();
    const cloud = snap.docs.map(d => ({ ...d.data(), id: d.id }));
    const cloudIds = new Set(cloud.map(t => t.id));
    const lokalNur = trips.filter(t => !cloudIds.has(t.id));
    trips = [...cloud, ...lokalNur];
    writeLocal();
    // Was nur lokal lag, gehört in die Cloud – sonst ist es beim nächsten
    // Gerätewechsel weg.
    for (const t of lokalNur) await col.doc(t.id).set(sanitize(t));
  } catch (e) {
    console.warn('Trips konnten nicht geladen werden, nutze lokalen Stand:', e);
  }
  loaded = true;
  return getTrips();
}

export async function saveTrip(trip) {
  trip.updated = Date.now();
  const i = trips.findIndex(t => t.id === trip.id);
  if (i === -1) trips.push(trip); else trips[i] = trip;
  writeLocal();

  const col = collection();
  if (col) {
    try { await col.doc(trip.id).set(sanitize(trip)); }
    catch (e) { console.warn('Trip konnte nicht in die Cloud geschrieben werden:', e); }
  }
  return trip;
}

export async function deleteTrip(id) {
  trips = trips.filter(t => t.id !== id);
  writeLocal();
  const col = collection();
  if (col) {
    try { await col.doc(id).delete(); }
    catch (e) { console.warn('Trip konnte nicht aus der Cloud gelöscht werden:', e); }
  }
}

// Lesbare, stabile ID aus Ziel und Startdatum: „caorle-2026-07".
export function makeTripId({ to, title, dateStart }) {
  const basis = (to || title || 'trip')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'trip';
  const monat = (dateStart || '').slice(0, 7) || 'ohne-datum';
  let id = `${basis}-${monat}`;
  let n = 2;
  while (trips.some(t => t.id === id)) id = `${basis}-${monat}-${n++}`;
  return id;
}

export function newTrip(felder = {}) {
  return { ...emptyTrip(makeTripId(felder)), ...felder };
}
