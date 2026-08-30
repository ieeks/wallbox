// =====================================================================
// TRIP-OBERFLÄCHE
// =====================================================================
// Rendert in die beiden Seiten `page-trips` und `page-trip-detail`. Beide
// folgen dem Muster, das der Ladefuchs für `page-detail` schon nutzt: die
// Seite steht leer im HTML und wird per innerHTML gefüllt.
//
// Gestaltung kommt vollständig aus dem Bestand – Design-Tokens, Karten,
// Abstände. Der Trip-Report soll wie ein Teil der App aussehen, nicht wie
// ein Fremdkörper. Die Struktur (Kennzahlen-Trio, Stopps-Liste, Leg-Split,
// Vergleichskarten) folgt reference/trip-reports.html.
// =====================================================================
import { aggregateTrip } from './calc.js';
import { LEG_LABELS, LEGS, fromHomeCharge, fromInvoiceCharge, effectiveKwh, isEstimatedKwh, estimateKwhFromMinutes } from './model.js';
import { getTrips, getTrip, lf } from './store.js';

const PROVIDER_LABELS = {
  'tesla-at': 'Tesla AT',
  'tesla-de': 'Tesla DE',
  'tesla-it': 'Tesla IT',
  'ionity': 'IONITY',
  'electra': 'Electra',
  'ewe-go': 'EWE Go',
  'home': 'go-e',
  'manuell': 'von Hand',
};

const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fmt = (n, d = 2) => (lf().fmt ? lf().fmt(n, d) : Number(n).toFixed(d));

const fmtDate = iso => {
  if (!iso) return '–';
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
};

const fmtDateShort = iso => {
  if (!iso) return '–';
  const [, m, d] = iso.split('-');
  return `${d}.${m}.`;
};

// =====================================================================
// Ladungen eines Trips einsammeln: Fremdladungen aus dem Trip-Dokument,
// Heimladungen als Projektion des bestehenden charges[].
// =====================================================================
export function tripCharges(trip) {
  const bestand = lf().charges || [];
  const heim = (trip.homeChargeIds || [])
    .map(id => bestand.find(c => c.id === id))
    .filter(Boolean)
    .map(c => {
      const h = fromHomeCharge(c, trip);
      // Eine von Hand geänderte Fahrtrichtung liegt im Trip, nicht am
      // Bestandseintrag – charges[] bleibt unangetastet.
      const override = (trip.homeLegs || {})[c.id];
      return override ? { ...h, leg: override } : h;
    });
  const fremd = (trip.charges || []).map(c => fromInvoiceCharge(c, trip));
  return [...heim, ...fremd];
}

export function tripSummary(trip) {
  const s = lf().settings || {};
  const andere = getTrips()
    .filter(t => t.id !== trip.id)
    .map(t => aggregateTrip({ trip: t, charges: tripCharges(t) }));

  return aggregateTrip({
    trip,
    charges: tripCharges(trip),
    fuelPrice: lf().benzinPreis ? lf().benzinPreis() : s.comp_benzin_preis,
    litersPer100Min: s.comp_benzin_verbrauch_l,
    litersPer100Max: s.comp_benzin_verbrauch_l_max ?? s.comp_benzin_verbrauch_l,
    previousTrips: andere,
  });
}

// Ergebnis des letzten PDF-Imports. Liegt hier statt im DOM, damit es ein
// Neu-Rendern der Detailseite übersteht – die „von Hand eintragen"-Knöpfe
// der unerkannten Dateien müssen anklickbar bleiben.
let importReport = null;

export function setImportReport(report) {
  importReport = report;
}

// =====================================================================
// TRIP-LISTE
// =====================================================================
// =====================================================================
// VERGLEICH ÜBER ALLE TRIPS (Spec §9)
// =====================================================================
// Zwei getrennte Diagramme, bewusst KEINE zweite Y-Achse: Verbrauch
// (kWh/100km) und Preis (€/kWh) haben nichts miteinander zu tun, und eine
// gemeinsame Skala würde eine Beziehung suggerieren, die es nicht gibt.
//
// Je Diagramm eine Datenreihe – deshalb keine Legende, der Titel benennt
// sie. Werte stehen direkt an den Balken (bei so wenigen Trips lesbarer als
// ein Tooltip allein), Details hängen zusätzlich am `title`.
//
// Trips ohne Kilometer haben keinen Verbrauch. Die bekommen einen
// Stummel-Balken und „—", nicht 0 – dieselbe Regel wie beim Peak-Diagramm:
// ein fehlender Messwert ist keine Null.
function compareChart({ title, subtitle, rows, unit, digits }) {
  const werte = rows.map(r => r.value).filter(v => typeof v === 'number' && v > 0);
  if (!werte.length) return '';
  const max = Math.max(...werte) * 1.18;

  return `
    <div class="tcmp-block">
      <div class="tcmp-head">
        <span class="tcmp-title">${esc(title)}</span>
        <span class="tcmp-sub">${esc(subtitle)}</span>
      </div>
      <div class="tcmp-plot">
        <div class="tcmp-bars">
          ${rows.map(r => {
            const hat = typeof r.value === 'number' && r.value > 0;
            const h = hat ? Math.max(4, (r.value / max) * 100) : null;
            return `
              <div class="tcmp-col" title="${esc(r.title)}">
                <div class="tcmp-val${hat ? '' : ' is-none'}">${hat ? fmt(r.value, digits) : '—'}</div>
                <div class="${hat ? 'tcmp-bar' : 'tcmp-bar-none'}"${hat ? ` style="height:${h}%"` : ''}></div>
              </div>`;
          }).join('')}
        </div>
      </div>
      <div class="tcmp-labels">
        ${rows.map(r => `<div class="tcmp-label">
          <span class="tcmp-name-short">${esc(r.name)}</span>
          <span class="tcmp-date">${esc(r.date)}</span>
        </div>`).join('')}
      </div>
      <div class="tcmp-unit">${esc(unit)}</div>
    </div>`;
}

export function renderTripCompare() {
  const trips = getTrips();
  if (trips.length < 2) return '';

  // Zeitachse: älteste links. getTrips() sortiert für die Liste absteigend.
  const daten = [...trips].reverse().map(t => {
    const r = tripSummary(t);
    const name = t.title || t.to || t.id;
    return {
      trip: t,
      dateLabel: fmtDateShort(t.dateStart),
      name,
      consumption: r.consumption,
      avgPrice: r.avgPrice,
      kwh: r.kwhTotal,
      cost: r.costTotal,
      km: r.km,
      kmEstimated: r.kmEstimated,
    };
  });

  const verbrauch = compareChart({
    title: 'Verbrauch je Trip',
    subtitle: 'kWh/100km',
    unit: 'Trips chronologisch, älteste links',
    digits: 1,
    rows: daten.map(d => ({
      name: d.name,
      date: d.dateLabel,
      value: d.consumption,
      title: `${d.name}: ${d.consumption !== null ? fmt(d.consumption, 1) + ' kWh/100km' : 'keine Kilometer eingetragen'}`,
    })),
  });

  const preis = compareChart({
    title: 'Ø-Ladepreis je Trip',
    subtitle: '€/kWh brutto, inkl. Heimladung',
    unit: 'Trips chronologisch, älteste links',
    digits: 3,
    rows: daten.map(d => ({
      name: d.name,
      date: d.dateLabel,
      value: d.avgPrice,
      title: `${d.name}: ${d.avgPrice !== null ? fmt(d.avgPrice, 3) + ' €/kWh' : 'keine Ladungen'}`,
    })),
  });

  // Tabelle neben den Diagrammen: die Zahlen sollen auch ohne Farbe und
  // ohne Balkenlängen lesbar sein.
  const tabelle = `
    <div class="tcmp-table">
      <div class="tcmp-row is-head">
        <span>Trip</span><span>km</span><span>kWh</span><span>kWh/100km</span><span>€/kWh</span><span>€</span>
      </div>
      ${daten.map(d => `
        <div class="tcmp-row">
          <span class="tcmp-name">${esc(d.name)}</span>
          <span>${d.km ? (d.kmEstimated ? '~' : '') + fmt(d.km, 0) : '—'}</span>
          <span>${fmt(d.kwh, 0)}</span>
          <span>${d.consumption !== null ? fmt(d.consumption, 1) : '—'}</span>
          <span>${d.avgPrice !== null ? fmt(d.avgPrice, 3) : '—'}</span>
          <span>${fmt(d.cost, 0)}</span>
        </div>`).join('')}
    </div>`;

  const body = verbrauch + preis + tabelle;
  // sectionShell() aus script.js: gleiche Optik und dieselbe
  // Zuklapp-Persistenz wie die Dashboard-Sektionen.
  return window.sectionShell
    ? window.sectionShell('trip-compare', '📈 Trips im Vergleich', body)
    : `<div class="section-title">Trips im Vergleich</div>${body}`;
}

export function renderTripList() {
  const el = document.getElementById('page-trips');
  if (!el) return;

  const trips = getTrips();
  const karten = trips.map(t => {
    const r = tripSummary(t);
    return `
      <div class="trip-card" role="button" tabindex="0" onclick="tripOpen('${esc(t.id)}')"
           onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();tripOpen('${esc(t.id)}');}">
        <div class="tc-head">
          <div class="tc-title">${esc(t.title || t.to || 'Ohne Titel')}</div>
          <div class="tc-cost">${fmt(r.costTotal)} €</div>
        </div>
        <div class="tc-sub">${fmtDate(t.dateStart)} – ${fmtDate(t.dateEnd)}</div>
        <div class="tc-stats">
          <span>${r.km ? (r.kmEstimated ? '~' : '') + fmt(r.km, 0) + ' km' : '– km'}</span>
          <span>${fmt(r.kwhTotal, 1)} kWh</span>
          <span>${r.consumption !== null ? fmt(r.consumption, 1) + ' kWh/100km' : '–'}</span>
          <span>${r.count} Stopp${r.count === 1 ? '' : 's'}</span>
        </div>
        ${r.warnings.some(w => w.level === 'warn')
          ? `<div class="tc-warn">⚠️ ${r.warnings.filter(w => w.level === 'warn').length} offene${r.warnings.filter(w => w.level === 'warn').length === 1 ? 'r Punkt' : ' Punkte'}</div>`
          : ''}
      </div>`;
  }).join('');

  el.innerHTML = `
    <div class="page-title-area">
      <div class="page-tag">Reisen</div>
      <div class="page-title">Trip-Reports</div>
      <div class="page-subtitle">Ladebelege einer Reise zusammenfassen und mit dem Verbrenner vergleichen.</div>
    </div>
    <button class="btn-save" onclick="tripNew()" style="margin-top:8px;">+ Neuer Trip</button>
    ${trips.length
      ? `<div class="trip-list">${karten}</div>${renderTripCompare()}`
      : `<div class="empty-state" style="margin-top:24px;">
           <span class="material-symbols-outlined">luggage</span>
           Noch kein Trip angelegt.
         </div>`}
  `;
}

// =====================================================================
// TRIP-DETAIL – der eigentliche Report
// =====================================================================
export function renderTripDetail(tripId) {
  const el = document.getElementById('page-trip-detail');
  const trip = getTrip(tripId);
  if (!el || !trip) return;

  const r = tripSummary(trip);

  el.innerHTML = `
    <div class="detail-header">
      <button class="detail-back" onclick="tripsOpenList()" aria-label="Zurück zur Trip-Liste">
        <span class="material-symbols-outlined">arrow_back</span>
      </button>
      <div class="detail-title">${esc(trip.title || trip.to || 'Trip')}</div>
      <button class="detail-back" onclick="tripEdit('${esc(trip.id)}')" aria-label="Trip bearbeiten">
        <span class="material-symbols-outlined">edit</span>
      </button>
    </div>

    <div class="trip-hero">
      <div class="th-eyebrow">Trip-Report · ${fmtDateShort(trip.dateStart)}–${fmtDate(trip.dateEnd)}</div>
      <div class="th-route">${esc(trip.from || 'Start')} ↔ ${esc(trip.to || 'Ziel')}</div>
      <div class="th-meta">
        <span><b>${r.km ? (r.kmEstimated ? '~' : '') + fmt(r.km, 0) + ' km' : 'km fehlen'}</b>${
          // Spec §6: eine hochgerechnete Kilometerleistung wird mit ihrem
          // Plausibilitätsband ausgewiesen, nicht als scheinbar exakte Zahl.
          r.kmEstimated && r.kmBand
            ? ` (geschätzt, ${fmt(r.kmBand.low, 0)}–${fmt(r.kmBand.high, 0)})`
            : (r.kmEstimated ? ' (geschätzt)' : '')
        }</span>
        <span>${esc(vehicleLabel(trip.vehicle))}</span>
        <span>${r.homeCount} × daheim + ${r.count - r.homeCount} Stopp${r.count - r.homeCount === 1 ? '' : 's'}</span>
      </div>
    </div>

    <div class="dash-stats trip-stats">
      <div class="stat-card">
        <div class="stat-label">Energie</div>
        <div class="stat-value">${fmt(r.kwhTotal, 1)}${r.hasEstimates ? '*' : ''} <span class="stat-unit">kWh</span></div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Verbrauch</div>
        <div class="stat-value">${r.consumption !== null ? fmt(r.consumption, 1) : '–'} <span class="stat-unit">kWh/100km</span></div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Ladekosten</div>
        <div class="stat-value">${fmt(r.costTotal)} <span class="stat-unit">€</span></div>
      </div>
    </div>

    ${renderWarnings(r.warnings)}
    ${renderStops(trip, r)}
    ${renderLegs(r)}
    ${renderFuel(trip, r)}
    ${renderDropZone(trip)}
    ${renderHomePicker(trip)}

    <button class="btn-danger" style="margin-top:24px;" onclick="tripAskDelete('${esc(trip.id)}')">
      Trip löschen
    </button>
  `;
}

function vehicleLabel(v) {
  return v === 'byd-seal-u' ? 'BYD Seal U Design' : (v || 'Fahrzeug');
}

function renderWarnings(warnings) {
  if (!warnings.length) return '';
  return `<div class="trip-warnings">${warnings.map(w => `
    <div class="trip-warn ${w.level === 'warn' ? 'is-warn' : 'is-info'}">
      <span>${w.level === 'warn' ? '⚠️' : 'ℹ️'}</span><div>${esc(w.text)}</div>
    </div>`).join('')}</div>`;
}

function renderStops(trip, r) {
  if (!r.charges.length) {
    return `<div class="section-title">Ladestopps</div>
      <div class="empty-state" style="padding:20px;">Noch keine Ladung zugeordnet.<br>
      Rechnungen unten ablegen oder eine Heimladung auswählen.</div>`;
  }

  const zeilen = r.charges.map(c => {
    const kwh = effectiveKwh(c);
    const geschaetzt = isEstimatedKwh(c);
    const proKwh = kwh > 0 && c.grossTotal ? c.grossTotal / kwh : null;
    return `
      <div class="trip-row${c.isHome ? ' is-home' : ''}">
        <div class="tr-left">
          <div class="tr-name">
            ${esc(c.location || 'Unbekannter Ort')}
            <span class="tr-tag">${esc(PROVIDER_LABELS[c.provider] || c.provider || '')}</span>
            ${geschaetzt ? '<span class="tr-tag is-est">geschätzt</span>' : ''}
            ${c.isAggregate ? '<span class="tr-tag is-warn">Sammelrechnung</span>' : ''}
            ${c.needsReview ? '<span class="tr-tag is-warn">prüfen</span>' : ''}
          </div>
          <div class="tr-meta">
            ${fmtDateShort(c.date)} · ${kwh !== null ? fmt(kwh, kwh < 100 ? 2 : 1) + ' kWh' : 'kWh unbekannt'}
            ${c.minutes ? ' · ' + fmt(c.minutes, 0) + ' min' : ''}
          </div>
          <div class="tr-actions">
            <select class="tr-leg" aria-label="Fahrtabschnitt"
                    onchange="tripSetLeg('${esc(trip.id)}','${esc(c.id)}',this.value)">
              ${LEGS.map(l => `<option value="${l}"${c.leg === l ? ' selected' : ''}>${LEG_LABELS[l]}</option>`).join('')}
            </select>
            ${geschaetzt && !c.isHome && !c.isAggregate ? `
              <button class="tr-btn" onclick="tripEstimate('${esc(trip.id)}','${esc(c.id)}')">kWh schätzen</button>` : ''}
            ${c.isAggregate ? `
              <button class="tr-btn" onclick="tripOpenSplit('${esc(trip.id)}','${esc(c.id)}')">aufteilen</button>` : ''}
            ${c.splitFrom ? `
              <button class="tr-btn" onclick="tripUndoSplit('${esc(trip.id)}','${esc(c.splitFrom)}')">Aufteilung zurücknehmen</button>` : ''}
            ${!c.isHome && !c.isAggregate ? `
              <button class="tr-btn" onclick="tripEditCharge('${esc(trip.id)}','${esc(c.id)}')">bearbeiten</button>` : ''}
            ${!c.isHome ? `
              <button class="tr-btn is-del" onclick="tripRemoveCharge('${esc(trip.id)}','${esc(c.id)}')">entfernen</button>` : `
              <button class="tr-btn is-del" onclick="tripToggleHome('${esc(trip.id)}','${esc(c.id)}')">entfernen</button>`}
          </div>
        </div>
        <div class="tr-right">
          <div class="tr-amount">${c.grossTotal !== null ? fmt(c.grossTotal) + ' €' : '–'}</div>
          <div class="tr-rate">${proKwh ? fmt(proKwh, 3) + ' €/kWh' : '–'}</div>
        </div>
      </div>`;
  }).join('');

  return `
    <div class="section-title">Ladestopps</div>
    <div class="trip-card-plain">
      ${zeilen}
      <div class="trip-total">
        <span>Gesamt · ${fmt(r.kwhTotal, 2)} kWh</span>
        <span class="tt-val">${fmt(r.costTotal)} €</span>
      </div>
    </div>
    ${r.avgPrice !== null
      ? `<div class="trip-note">Ø ${fmt(r.avgPrice, 3)} €/kWh über alle Stopps.</div>`
      : ''}`;
}

function renderLegs(r) {
  const vorhanden = LEGS.filter(l => r.legs[l].count > 0);
  if (vorhanden.length < 2) return '';

  return `
    <div class="section-title">Hin- vs. Rückfahrt</div>
    <div class="trip-legs">
      ${vorhanden.map(l => {
        const leg = r.legs[l];
        return `<div class="leg-card">
          <div class="lg-title">${LEG_LABELS[l]}</div>
          <div class="lg-value">${fmt(leg.cost)} €</div>
          <div class="lg-sub">${fmt(leg.kwh, 1)}${leg.hasEstimates ? '*' : ''} kWh · ${leg.count} Stopp${leg.count === 1 ? '' : 's'}</div>
        </div>`;
      }).join('')}
    </div>`;
}

function renderFuel(trip, r) {
  if (!r.fuel) {
    return `<div class="section-title">Verbrenner-Vergleich</div>
      <div class="trip-note">Ohne Kilometer lässt sich nicht vergleichen – Kilometer im Trip eintragen.</div>`;
  }

  const f = r.fuel;
  const spanne = (a, b) => Math.abs(a - b) < 0.5 ? `${fmt(a, 0)} €` : `${fmt(a, 0)}–${fmt(b, 0)} €`;

  return `
    <div class="section-title">BYD vs. Verbrenner</div>
    <div class="trip-note">Gleiche ${r.kmEstimated ? '~' : ''}${fmt(r.km, 0)} km${r.kmEstimated ? ' (hochgerechnet)' : ''} mit einem Benziner
      (${fmt(f.litersPer100Min, 1)}–${fmt(f.litersPer100Max, 1)} L/100km,
      ${fmt(lf().benzinPreis ? lf().benzinPreis() : 0, 3)} €/L). Schätzung.</div>
    <div class="trip-compare">
      <div class="cmp-card is-ev">
        <div class="cc-head"><span class="cc-dot"></span>Elektrisch</div>
        <div class="cc-big">${fmt(r.costTotal)} €</div>
        <div class="cc-sub">${fmt(r.kwhTotal, 1)} kWh · Ø ${fmt(r.avgPrice ?? 0, 3)} €/kWh<br>inkl. Heimladung</div>
      </div>
      <div class="cmp-card is-fuel">
        <div class="cc-head"><span class="cc-dot"></span>Benzin</div>
        <div class="cc-big">${spanne(f.costMin, f.costMax)}</div>
        <div class="cc-sub">${fmt(f.literMin, 0)}–${fmt(f.literMax, 0)} L<br>${fmt(f.litersPer100Min, 1)}–${fmt(f.litersPer100Max, 1)} L/100km</div>
      </div>
    </div>
    <div class="trip-saving">
      <div class="ts-label">Ersparnis elektrisch</div>
      <div class="ts-amount">${spanne(f.savingMin, f.savingMax)}</div>
      <div class="ts-note">${fmt(f.evPer100)} €/100km statt ${fmt(f.fuelPer100Min)}–${fmt(f.fuelPer100Max)} €/100km</div>
    </div>`;
}

function renderDropZone(trip) {
  return `
    <div class="section-title">Rechnungen hinzufügen</div>
    <div class="drop-zone" id="trip-drop-zone" onclick="document.getElementById('trip-file-input').click()">
      <span class="material-symbols-outlined dz-icon">picture_as_pdf</span>
      <div class="dz-text">PDF-Rechnungen hierher ziehen – auch später noch,<br>der Report rechnet sich neu.</div>
      <span class="dz-btn">Dateien auswählen</span>
      <input type="file" id="trip-file-input" accept=".pdf" multiple/>
    </div>
    <div id="trip-import-status">${renderImportReport(trip)}</div>
    <button class="tariff-add-btn" style="margin-top:10px;" onclick="tripAddCharge('${esc(trip.id)}')">
      + Ladung von Hand eintragen
    </button>`;
}

// Unerkannte Dateien bekommen laut Spec §4 einen eigenen Bereich mit
// manueller Eingabemaske – eine Rechnung von einem Anbieter ohne Parser
// muss trotzdem in den Trip kommen.
export function renderImportReport(trip) {
  if (!importReport || importReport.tripId !== trip.id) return '';

  const { imported = 0, duplicates = 0, failed = [] } = importReport;
  const teile = [];
  if (imported) teile.push(`${imported} Ladung${imported === 1 ? '' : 'en'} übernommen`);
  if (duplicates) teile.push(`${duplicates} Duplikat${duplicates === 1 ? '' : 'e'} übersprungen`);

  return `
    ${teile.length ? `<div class="trip-note">${teile.join(' · ')}.</div>` : ''}
    ${failed.length ? `
      <div class="trip-note" style="margin-top:12px;">
        ${failed.length} Datei${failed.length === 1 ? '' : 'en'} nicht erkannt.
        Werte aus der Rechnung ablesen und von Hand eintragen:
      </div>
      <div class="unrec-list">
        ${failed.map((f, i) => `
          <div class="unrec-item">
            <div class="unrec-main">
              <div class="unrec-name">${esc(f.fileName)}</div>
              <div class="unrec-reason">${esc(f.reason)}</div>
            </div>
            <button class="tr-btn" onclick="tripAddCharge('${esc(trip.id)}', ${i})">eintragen</button>
          </div>`).join('')}
      </div>` : ''}`;
}

// Formular für einen Handeintrag – neu oder zur Korrektur einer geparsten Zeile.
export function renderChargeForm(trip, charge, hint) {
  const set = (id, wert) => { document.getElementById(id).value = wert ?? ''; };
  document.getElementById('charge-form-title').textContent =
    charge?.id ? 'Ladung bearbeiten' : 'Ladung eintragen';
  document.getElementById('charge-form-hint').textContent = hint || '';
  set('cf-id', charge?.id || '');
  set('cf-date', charge?.date || trip.dateStart || '');
  set('cf-location', charge?.location || '');
  set('cf-provider', charge?.provider || 'manuell');
  set('cf-kwh', charge?.kwh ?? '');
  set('cf-gross', charge?.grossTotal ?? '');
  set('cf-vat', charge?.vatRate != null ? Math.round(charge.vatRate * 100) : '');
  set('cf-leg', charge?.leg || 'onsite');
  document.getElementById('trip-charge-form').classList.add('show');
}

// Heimladungen werden NICHT dupliziert, sondern referenziert. Vorgeschlagen
// wird das Zeitfenster dateStart − 2 Tage bis dateEnd (Spec §5).
function renderHomePicker(trip) {
  const bestand = lf().charges || [];
  const von = shiftDate(trip.dateStart, -2);
  const bis = trip.dateEnd;
  const kandidaten = bestand
    .filter(c => c.date && (!von || c.date >= von) && (!bis || c.date <= bis))
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''));

  const gewaehlt = new Set(trip.homeChargeIds || []);

  if (!kandidaten.length) {
    return `<div class="section-title">Heimladungen</div>
      <div class="trip-note">Keine Ladung im Zeitraum ${fmtDate(von)} – ${fmtDate(bis)} gefunden.</div>`;
  }

  return `
    <div class="section-title">Heimladungen</div>
    <div class="trip-note">Ladungen aus dem Ladefuchs im Zeitfenster ${fmtDate(von)} – ${fmtDate(bis)}.
      Sie werden nur verknüpft, nicht kopiert.</div>
    <div class="trip-card-plain">
      ${kandidaten.map(c => `
        <label class="home-pick">
          <input type="checkbox" ${gewaehlt.has(c.id) ? 'checked' : ''}
                 onchange="tripToggleHome('${esc(trip.id)}','${esc(c.id)}')"/>
          <span class="hp-main">
            <span class="hp-date">${fmtDate(c.date)}${c.time ? ' · ' + esc(c.time) : ''}</span>
            <span class="hp-meta">${fmt(c.kwh ?? 0, 2)} kWh · ${fmt(c.total ?? 0)} €${c.snap ? ' · ☀️ SNAP' : ''}</span>
          </span>
        </label>`).join('')}
    </div>`;
}

function shiftDate(iso, days) {
  if (!iso) return null;
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// =====================================================================
// FORMULAR (anlegen / bearbeiten)
// =====================================================================
// =====================================================================
// SAMMELRECHNUNG AUFTEILEN (Spec §4.2, Edge Cases 2 und 3)
// =====================================================================
// Eingegeben werden die Einzelsessions aus der Anbieter-App (Datum, Ort,
// Betrag) – die kWh rechnet das Tool über den €/kWh-Satz der Rechnung
// zurück. Bewusst nicht andersherum: die App nennt Beträge, keine Mengen.
export function splitRowHTML(row = {}) {
  return `
    <div class="split-row">
      <input class="sp-date" type="date" value="${esc(row.date || '')}" oninput="tripSplitRecalc()"/>
      <input class="sp-loc" type="text" placeholder="Ort" value="${esc(row.location || '')}"/>
      <input class="sp-amount" type="number" step="0.01" min="0" inputmode="decimal"
             placeholder="0,00" value="${row.grossTotal ?? ''}" oninput="tripSplitRecalc()"/>
      <button type="button" class="sp-del" onclick="tripRemoveSplitRow(this)" aria-label="Zeile entfernen">×</button>
    </div>
    <div class="split-kwh"></div>`;
}

export function renderSplitInfo(charge) {
  const el = document.getElementById('split-info');
  if (!el) return;
  el.innerHTML = `
    Rechnung über <b>${fmt(charge.grossTotal)} €</b> / ${fmt(charge.kwh ?? 0, 3)} kWh
    (${fmt(charge.grossPerKwh ?? 0, 4)} €/kWh)${charge.periodStart ? `, Zeitraum ${fmtDate(charge.periodStart)} – ${fmtDate(charge.periodEnd)}` : ''}.<br>
    Trage die Ladevorgänge ein, die zu dieser Reise gehören. Was nicht dazugehört,
    lässt du einfach weg – die Rechnung muss nicht vollständig aufgeteilt werden.`;
}

// Prüfsumme: bewusst gegen die Summe der EINGEGEBENEN Sessions, nicht als
// harte Bedingung. Eine Monatsrechnung enthält regelmässig Ladungen
// ausserhalb der Reise (Edge Case 3); unvollständig ist erlaubt, zu viel
// nicht.
export function renderSplitCheck(charge, rows) {
  const el = document.getElementById('split-check');
  if (!el) return;

  const rate = charge.grossPerKwh || 0;
  const summe = rows.reduce((s, r) => s + (r.grossTotal || 0), 0);
  const rechnung = charge.grossTotal ?? 0;
  const rest = Math.round((rechnung - summe) * 100) / 100;
  const kwh = rate > 0 ? summe / rate : 0;

  let klasse = 'is-partial';
  let text;
  if (Math.abs(rest) <= 0.05) {
    klasse = 'is-complete';
    text = `<b>${fmt(summe)} €</b> zugeordnet · ${fmt(kwh, 2)} kWh — Rechnung vollständig aufgeteilt.`;
  } else if (rest < 0) {
    klasse = 'is-over';
    text = `<b>${fmt(summe)} €</b> zugeordnet · ${fmt(kwh, 2)} kWh — das sind
      <b>${fmt(Math.abs(rest))} €</b> mehr, als die Rechnung hergibt. Bitte Beträge prüfen.`;
  } else {
    text = `<b>${fmt(summe)} €</b> zugeordnet · ${fmt(kwh, 2)} kWh —
      <b>${fmt(rest)} €</b> bleiben ausserhalb der Reise.`;
  }
  el.className = `split-check ${klasse}`;
  el.innerHTML = text;
}

export function renderTripForm(trip) {
  const neu = !trip.title && !trip.dateStart;
  document.getElementById('trip-form-title').textContent = neu ? 'Neuer Trip' : 'Trip bearbeiten';
  document.getElementById('trip-f-id').value = trip.id || '';
  document.getElementById('trip-f-title').value = trip.title || '';
  document.getElementById('trip-f-from').value = trip.from || '';
  document.getElementById('trip-f-to').value = trip.to || '';
  document.getElementById('trip-f-start').value = trip.dateStart || '';
  document.getElementById('trip-f-end').value = trip.dateEnd || '';
  document.getElementById('trip-f-km').value = trip.km ?? '';
  document.getElementById('trip-form').classList.add('show');
}

export { PROVIDER_LABELS, esc, fmtDate, fmtDateShort, shiftDate };
