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
import { buildCharge } from '../parsers/charge.js';
import { getTrip, getTrips, loadTrips, saveTrip, deleteTrip, newTrip, isLoaded, lf } from './store.js';
import { renderTripList, renderTripDetail, renderTripForm, renderChargeForm, setImportReport,
         splitRowHTML, renderSplitInfo, renderSplitCheck } from './ui.js';
import { suggestLeg, estimateKwhFromMinutes, DEFAULT_ESTIMATE_KW } from './model.js';
import { outsideWindow, splitAggregate } from './calc.js';

let currentTripId = null;
let splitContext = null;   // { tripId, chargeId } während der Aufteilung
let chargeContext = null;  // { tripId, chargeId } während des Handeintrags

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
// LADUNG VON HAND (Spec §4: Unerkannt-Bereich mit Eingabemaske)
// =====================================================================
// Nicht nur für unbekannte Rechnungsformate: damit lässt sich auch eine
// geparste Zeile korrigieren, die als `needsReview` markiert wurde.
let lastFailed = [];

function tripAddCharge(tripId, failedIndex = null) {
  const trip = getTrip(tripId);
  if (!trip) return;
  const datei = failedIndex !== null ? lastFailed[failedIndex] : null;
  chargeContext = { tripId, chargeId: null, sourceFile: datei?.fileName || null };
  renderChargeForm(trip, null, datei
    ? `Aus „${datei.fileName}" – die Werte stehen auf der Rechnung.`
    : 'Für Rechnungen, die kein Parser lesen kann.');
}

function tripEditCharge(tripId, chargeId) {
  const trip = getTrip(tripId);
  const c = (trip?.charges || []).find(x => x.id === chargeId);
  if (!trip || !c) return;
  chargeContext = { tripId, chargeId, sourceFile: c.sourceFile || null };
  renderChargeForm(trip, c, c.needsReview ? (c.reviewReasons || []).join(' · ') : '');
}

function tripCloseChargeForm() {
  document.getElementById('trip-charge-form').classList.remove('show');
  chargeContext = null;
}

async function tripSaveCharge() {
  const trip = getTrip(chargeContext?.tripId);
  if (!trip) return;

  const wert = id => document.getElementById(id).value.trim();
  const zahl = id => {
    const n = parseFloat(wert(id).replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  };

  const date = wert('cf-date');
  const grossTotal = zahl('cf-gross');
  if (!date) return toast('Bitte ein Datum angeben');
  if (!(grossTotal > 0)) return toast('Bitte den Rechnungsbetrag angeben');

  const vatPct = zahl('cf-vat');
  const vatRate = vatPct !== null ? vatPct / 100 : null;
  const kwh = zahl('cf-kwh');

  const bestehend = chargeContext.chargeId;
  const charge = buildCharge({
    provider: wert('cf-provider') || 'manuell',
    // Handeinträge brauchen keine deterministische id – es gibt keine
    // Rechnung, die zweimal eingelesen werden könnte.
    id: bestehend || `manuell:${date}:${Date.now()}`,
    date,
    location: wert('cf-location') || null,
    kwh,
    grossTotal,
    netTotal: vatRate !== null ? Math.round((grossTotal / (1 + vatRate)) * 100) / 100 : null,
    vatRate,
    unitPriceBasis: 'unknown',
    reviewReasons: [],
  });
  charge.leg = wert('cf-leg') || suggestLeg(date, trip);
  charge.sourceFile = chargeContext.sourceFile;

  trip.charges = bestehend
    ? (trip.charges || []).map(c => (c.id === bestehend ? { ...c, ...charge } : c))
    : [...(trip.charges || []), charge];
  await saveTrip(trip);

  // Die Datei ist erledigt – sie soll nicht als „unerkannt" stehen bleiben.
  if (chargeContext.sourceFile && !bestehend) {
    lastFailed = lastFailed.filter(f => f.fileName !== chargeContext.sourceFile);
    setImportReport({ ...(importState || {}), failed: lastFailed });
  }

  tripCloseChargeForm();
  refresh();
  toast(bestehend ? 'Ladung aktualisiert' : 'Ladung eingetragen');
}

// =====================================================================
// SAMMELRECHNUNG AUFTEILEN (Spec §8)
// =====================================================================
function splitCharge() {
  const trip = getTrip(splitContext?.tripId);
  return (trip?.charges || []).find(c => c.id === splitContext?.chargeId) || null;
}

// Die Zeilen werden aus dem DOM gelesen statt in einer Modul-Variable
// gespiegelt – dasselbe Muster wie readTariffRows() in script.js.
function readSplitRows() {
  return [...document.querySelectorAll('#split-rows .split-row')].map(row => ({
    date: row.querySelector('.sp-date').value,
    location: row.querySelector('.sp-loc').value.trim(),
    grossTotal: parseFloat(String(row.querySelector('.sp-amount').value).replace(',', '.')),
  })).map(r => ({ ...r, grossTotal: Number.isFinite(r.grossTotal) ? r.grossTotal : 0 }));
}

function tripOpenSplit(tripId, chargeId) {
  splitContext = { tripId, chargeId };
  const c = splitCharge();
  if (!c) return;

  // Zwei leere Zeilen als Startpunkt – eine Sammelrechnung deckt praktisch
  // nie genau einen Ladevorgang ab.
  document.getElementById('split-rows').innerHTML = splitRowHTML() + splitRowHTML();
  renderSplitInfo(c);
  tripSplitRecalc();
  document.getElementById('trip-split').classList.add('show');
}

function tripCloseSplit() {
  document.getElementById('trip-split').classList.remove('show');
  splitContext = null;
}

function tripAddSplitRow() {
  document.getElementById('split-rows').insertAdjacentHTML('beforeend', splitRowHTML());
  tripSplitRecalc();
}

function tripRemoveSplitRow(btn) {
  const row = btn.closest('.split-row');
  const kwhZeile = row.nextElementSibling;
  if (kwhZeile && kwhZeile.classList.contains('split-kwh')) kwhZeile.remove();
  row.remove();
  tripSplitRecalc();
}

// Läuft bei jeder Eingabe: die zurückgerechnete Menge steht direkt an der
// Zeile, damit sichtbar ist, was der €/kWh-Satz aus dem Betrag macht.
function tripSplitRecalc() {
  const c = splitCharge();
  if (!c) return;
  const rate = c.grossPerKwh || 0;

  [...document.querySelectorAll('#split-rows .split-row')].forEach(row => {
    const betrag = parseFloat(String(row.querySelector('.sp-amount').value).replace(',', '.'));
    const ziel = row.nextElementSibling;
    if (!ziel || !ziel.classList.contains('split-kwh')) return;
    // Über fmt() aus script.js, damit die Zahl wie überall sonst in der App
    // mit Dezimalkomma steht.
    const f = lf().fmt || ((n, d) => Number(n).toFixed(d));
    ziel.textContent = Number.isFinite(betrag) && betrag > 0 && rate > 0
      ? `≈ ${f(betrag / rate, 2)} kWh`
      : '';
  });

  renderSplitCheck(c, readSplitRows());
}

async function tripApplySplit() {
  const trip = getTrip(splitContext?.tripId);
  const aggregat = splitCharge();
  if (!trip || !aggregat) return;

  const zeilen = readSplitRows().filter(r => r.grossTotal > 0 && r.date);
  if (!zeilen.length) return toast('Bitte mindestens einen Ladevorgang mit Datum und Betrag eintragen');

  const r = splitAggregate(aggregat, zeilen);
  if (r.difference > 0.05) {
    // Zu viel zugeordnet ist ein Tippfehler, zu wenig ist erlaubt.
    return toast(`${r.sumSplits.toFixed(2)} € übersteigen die Rechnung um ${Math.abs(r.difference).toFixed(2)} €`);
  }

  // Das Original wird aufgehoben, nicht weggeworfen: sonst legt ein erneutes
  // Ablegen derselben PDF die Sammelrechnung neben den Splits noch einmal an.
  trip.splitAggregates = { ...(trip.splitAggregates || {}), [aggregat.id]: aggregat };
  trip.charges = [
    ...(trip.charges || []).filter(c => c.id !== aggregat.id),
    ...r.charges.map(c => ({ ...c, leg: suggestLeg(c.date, trip) })),
  ];
  await saveTrip(trip);

  tripCloseSplit();
  refresh();
  toast(`${r.charges.length} Ladevorgang${r.charges.length === 1 ? '' : 'e'} übernommen`
    + (r.complete ? '' : ` · ${Math.abs(r.difference).toFixed(2)} € blieben draussen`));
}

async function tripUndoSplit(tripId, aggregateId) {
  const trip = getTrip(tripId);
  const original = (trip?.splitAggregates || {})[aggregateId];
  if (!trip || !original) return;

  trip.charges = [...(trip.charges || []).filter(c => c.splitFrom !== aggregateId), original];
  delete trip.splitAggregates[aggregateId];
  await saveTrip(trip);
  refresh();
  toast('Aufteilung zurückgenommen');
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

let importState = null;

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
        fehler.push({ fileName: file.name, reason: r.error || 'Format nicht erkannt' });
        continue;
      }
      neu.push(...r.charges);
    } catch (e) {
      // Ein kaputtes PDF darf einen Mehrfach-Import nicht abbrechen.
      const grund = e instanceof PdfTextError ? e.message
        : e instanceof PdfLoadError ? e.message
        : `konnte nicht gelesen werden (${e.message})`;
      fehler.push({ fileName: file.name, reason: grund });
    }
  }

  // Edge Case 7: dieselbe Rechnung zweimal fallen gelassen.
  // Auch bereits aufgeteilte Sammelrechnungen zählen als vorhanden – sonst
  // käme das Original beim erneuten Ablegen neben seinen Splits zurück.
  const vorhanden = new Set([
    ...(trip.charges || []).map(c => c.id),
    ...Object.keys(trip.splitAggregates || {}),
  ]);
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

  lastFailed = fehler;
  importState = {
    tripId: trip.id,
    imported: uebernommen.length,
    duplicates: doppelt,
    failed: fehler,
  };
  setImportReport(importState);

  await saveTrip(trip);
  renderTripDetail(trip.id);
  initDropZone();

  if (uebernommen.length) toast(`${uebernommen.length} Ladung${uebernommen.length === 1 ? '' : 'en'} hinzugefügt`);
  else if (fehler.length) toast(`${fehler.length} Datei${fehler.length === 1 ? '' : 'en'} nicht erkannt`);
}

// =====================================================================
// BOOTSTRAP
// =====================================================================
Object.assign(window, {
  tripsOpenList, tripOpen, tripNew, tripEdit, tripCloseForm, tripSaveForm,
  tripAskDelete, tripSetLeg, tripRemoveCharge, tripToggleHome, tripEstimate,
  tripOpenSplit, tripCloseSplit, tripAddSplitRow, tripRemoveSplitRow,
  tripSplitRecalc, tripApplySplit, tripUndoSplit,
  tripAddCharge, tripEditCharge, tripCloseChargeForm, tripSaveCharge,
});

// Die Trip-Liste wird beim Start nur vorgerendert (aus localStorage), damit
// die Seite nicht leer aufblitzt. Firestore wird erst beim Öffnen befragt.
renderTripList();
