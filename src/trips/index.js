// =====================================================================
// TRIP-REPORTS – Einstiegspunkt
// =====================================================================
// Wird von index.html als eigenes Modul-Script geladen, NACH script.js.
// Das klassische script.js bleibt unverändert; der Zugriff auf dessen
// Zustand läuft über `window.lfBridge` (in index.html gesetzt), der Zugriff
// aus dem HTML heraus über die hier gesetzten `window.trip*`-Funktionen –
// dasselbe onclick-Muster, das die App überall verwendet.
//
// pdf.js wird erst beim ersten Import einer Rechnung geladen.
// =====================================================================
import { extractPdfLines, PdfTextError, PdfLoadError } from '../lib/pdf.js';
import { parseInvoiceText, dedupeCharges } from '../parsers/index.js';
import { getTrip, getTrips, loadTrips, saveTrip, deleteTrip, newTrip, isLoaded, lf } from './store.js';
import { renderTripList, renderTripDetail, renderTripForm, tripCharges, tripSummary } from './ui.js';
import { suggestLeg, estimateKwhFromMinutes, DEFAULT_ESTIMATE_KW } from './model.js';
import { outsideWindow } from './calc.js';

let currentTripId = null;

const toast = msg => (window.showToast ? window.showToast(msg) : console.log(msg));

function refresh() {
  if (currentTripId) renderTripDetail(currentTripId);
  else renderTripList();
}

// =====================================================================
// NAVIGATION
// =====================================================================
async function tripsOpenList() {
  currentTripId = null;
  window.showPage('trips', document.querySelector('.nav-item[data-page="trips"]'));
  if (!isLoaded()) {
    renderTripList();
    await loadTrips();
  }
  renderTripList();
}

function tripOpen(id) {
  currentTripId = id;
  window.showPage('trip-detail', document.querySelector('.nav-item[data-page="trips"]'));
  renderTripDetail(id);
  initDropZone();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// =====================================================================
// TRIP ANLEGEN / BEARBEITEN
// =====================================================================
function tripNew() {
  renderTripForm({ id: '', title: '', from: 'Wien', to: '', dateStart: '', dateEnd: '', km: null });
}

function tripEdit(id) {
  const t = getTrip(id);
  if (t) renderTripForm(t);
}

function tripCloseForm() {
  document.getElementById('trip-form').classList.remove('show');
}

async function tripSaveForm() {
  const wert = id => document.getElementById(id).value.trim();
  const id = wert('trip-f-id');
  const kmRoh = wert('trip-f-km');
  const felder = {
    title: wert('trip-f-title'),
    from: wert('trip-f-from'),
    to: wert('trip-f-to'),
    dateStart: wert('trip-f-start'),
    dateEnd: wert('trip-f-end'),
    km: kmRoh === '' ? null : Number(kmRoh),
    kmEstimated: false,
  };

  if (!felder.dateStart || !felder.dateEnd) return toast('Bitte Start- und Enddatum angeben');
  if (felder.dateEnd < felder.dateStart) return toast('Das Enddatum liegt vor dem Start');
  if (!felder.title) felder.title = [felder.from, felder.to].filter(Boolean).join(' ↔ ') || 'Trip';

  const trip = id ? { ...getTrip(id), ...felder } : newTrip(felder);
  await saveTrip(trip);
  tripCloseForm();
  toast(id ? 'Trip aktualisiert' : 'Trip angelegt');
  tripOpen(trip.id);
}

function tripAskDelete(id) {
  const t = getTrip(id);
  if (!t) return;
  if (!confirm(`Trip „${t.title}" löschen? Die verknüpften Heimladungen bleiben erhalten.`)) return;
  deleteTrip(id).then(() => { toast('Trip gelöscht'); tripsOpenList(); });
}

// =====================================================================
// LADUNGEN BEARBEITEN
// =====================================================================
async function tripSetLeg(tripId, chargeId, leg) {
  const trip = getTrip(tripId);
  if (!trip) return;
  const c = (trip.charges || []).find(x => x.id === chargeId);
  if (c) { c.leg = leg; }
  else {
    // Heimladungen liegen nicht im Trip-Dokument; ihre abweichende Zuordnung
    // wird separat gemerkt, damit charges[] unangetastet bleibt.
    trip.homeLegs = { ...(trip.homeLegs || {}), [chargeId]: leg };
  }
  await saveTrip(trip);
  refresh();
}

async function tripRemoveCharge(tripId, chargeId) {
  const trip = getTrip(tripId);
  if (!trip) return;
  trip.charges = (trip.charges || []).filter(c => c.id !== chargeId);
  await saveTrip(trip);
  refresh();
}

async function tripToggleHome(tripId, chargeId) {
  const trip = getTrip(tripId);
  if (!trip) return;
  const ids = new Set(trip.homeChargeIds || []);
  if (ids.has(chargeId)) ids.delete(chargeId); else ids.add(chargeId);
  trip.homeChargeIds = [...ids];
  await saveTrip(trip);
  refresh();
}

// Minutentarif: die Rechnung nennt keine kWh, also wird gefragt statt geraten.
async function tripEstimate(tripId, chargeId) {
  const trip = getTrip(tripId);
  const c = (trip?.charges || []).find(x => x.id === chargeId);
  if (!c) return;

  const vorschlag = c.kwhEstimate ?? estimateKwhFromMinutes(c.minutes) ?? '';
  const eingabe = prompt(
    `Geschätzte Energiemenge in kWh${c.minutes ? ` (${c.minutes} min bei ${DEFAULT_ESTIMATE_KW} kW ≈ ${estimateKwhFromMinutes(c.minutes)} kWh)` : ''}:`,
    String(vorschlag),
  );
  if (eingabe === null) return;

  const wert = Number(String(eingabe).replace(',', '.'));
  c.kwhEstimate = Number.isFinite(wert) && wert > 0 ? wert : null;
  await saveTrip(trip);
  refresh();
}

// =====================================================================
// PDF-IMPORT
// =====================================================================
function initDropZone() {
  const dz = document.getElementById('trip-drop-zone');
  const fi = document.getElementById('trip-file-input');
  if (!dz || !fi || dz.dataset.wired) return;
  dz.dataset.wired = '1';

  ['dragenter', 'dragover'].forEach(e =>
    dz.addEventListener(e, ev => { ev.preventDefault(); dz.classList.add('drag-over'); }));
  ['dragleave', 'drop'].forEach(e =>
    dz.addEventListener(e, ev => { ev.preventDefault(); dz.classList.remove('drag-over'); }));

  dz.addEventListener('drop', ev => importFiles([...(ev.dataTransfer?.files || [])]));
  fi.addEventListener('change', ev => { importFiles([...ev.target.files]); ev.target.value = ''; });
}

function status(html) {
  const el = document.getElementById('trip-import-status');
  if (el) el.innerHTML = html;
}

async function importFiles(files) {
  const trip = getTrip(currentTripId);
  if (!trip || !files.length) return;

  status(`<div class="trip-note">${files.length} Datei${files.length === 1 ? '' : 'en'} werden gelesen …</div>`);

  const neu = [];
  const fehler = [];

  for (const file of files) {
    try {
      const { text } = await extractPdfLines(file);
      const r = parseInvoiceText(text, { fileName: file.name });
      if (r.unrecognized) {
        fehler.push(`${file.name}: ${r.error || 'Format nicht erkannt'}`);
        continue;
      }
      neu.push(...r.charges);
    } catch (e) {
      // Ein kaputtes PDF darf einen Mehrfach-Import nicht abbrechen.
      const grund = e instanceof PdfTextError ? e.message
        : e instanceof PdfLoadError ? e.message
        : `konnte nicht gelesen werden (${e.message})`;
      fehler.push(`${file.name}: ${grund}`);
    }
  }

  // Edge Case 7: dieselbe Rechnung zweimal fallen gelassen.
  const vorhanden = new Set((trip.charges || []).map(c => c.id));
  const frisch = dedupeCharges(neu).filter(c => !vorhanden.has(c.id));
  const doppelt = neu.length - frisch.length;

  // Edge Case 8: ausserhalb des Reisezeitraums wird gefragt, nicht still
  // zugeordnet.
  const uebernommen = [];
  for (const c of frisch) {
    if (outsideWindow(c.date, trip)) {
      const ok = confirm(
        `„${c.location || c.provider}" vom ${c.date} liegt ausserhalb des Reisezeitraums `
        + `(${trip.dateStart} – ${trip.dateEnd}).\n\nTrotzdem zu diesem Trip hinzufügen?`,
      );
      if (!ok) continue;
    }
    uebernommen.push({ ...c, leg: suggestLeg(c.date, trip) });
  }

  trip.charges = [...(trip.charges || []), ...uebernommen];
  await saveTrip(trip);
  renderTripDetail(trip.id);
  initDropZone();

  const teile = [];
  if (uebernommen.length) teile.push(`${uebernommen.length} Ladung${uebernommen.length === 1 ? '' : 'en'} übernommen`);
  if (doppelt) teile.push(`${doppelt} Duplikat${doppelt === 1 ? '' : 'e'} übersprungen`);
  status(`
    ${teile.length ? `<div class="trip-note">${teile.join(' · ')}.</div>` : ''}
    ${fehler.length ? `<div class="trip-warn is-warn"><span>⚠️</span><div>${fehler.map(f => f.replace(/</g, '&lt;')).join('<br>')}</div></div>` : ''}
  `);
  if (uebernommen.length) toast(`${uebernommen.length} Ladung${uebernommen.length === 1 ? '' : 'en'} hinzugefügt`);
}

// =====================================================================
// BOOTSTRAP
// =====================================================================
Object.assign(window, {
  tripsOpenList, tripOpen, tripNew, tripEdit, tripCloseForm, tripSaveForm,
  tripAskDelete, tripSetLeg, tripRemoveCharge, tripToggleHome, tripEstimate,
});

// Die Trip-Liste wird beim Start nur vorgerendert (aus localStorage), damit
// die Seite nicht leer aufblitzt. Firestore wird erst beim Öffnen befragt.
renderTripList();
