// =====================================================================
// TRIP-DATENMODELL
// =====================================================================
// Ein Trip ist eine Gruppierung über Ladesessions plus Kilometerstand –
// kein zweites Produkt. Entsprechend gibt es zwei Sorten Ladungen:
//
//   • Fremdladungen aus PDF-Rechnungen. Die liegen IM Trip-Dokument, denn
//     ausserhalb existieren sie nicht.
//   • Heimladungen aus dem bestehenden `charges[]` des Ladefuchs. Die werden
//     nur per `id` referenziert, nie kopiert (Spec §5) – sonst zeigt das
//     Dashboard andere Zahlen als der Trip-Report.
// =====================================================================
import { round } from '../lib/num.js';

export const LEGS = ['outbound', 'onsite', 'return'];

export const LEG_LABELS = {
  outbound: 'Hinfahrt',
  onsite: 'Vor Ort',
  return: 'Rückfahrt',
};

// Minutentarif-Ladungen nennen keine kWh. Der Vorschlag ist Dauer × Ø-Leistung;
// die Zahl ist eine Schätzung und wird als solche gekennzeichnet, nie still
// als Messwert verkauft.
export const DEFAULT_ESTIMATE_KW = 90;

export function emptyTrip(id) {
  return {
    id,
    title: '',
    from: '',
    to: '',
    dateStart: '',
    dateEnd: '',
    km: null,
    kmEstimated: false,
    vehicle: 'byd-seal-u',
    charges: [],        // Fremdladungen aus Rechnungen
    homeChargeIds: [],  // Referenzen in das bestehende charges[]
    created: Date.now(),
  };
}

// Vorschlag für die Fahrtrichtung. Das Ladedatum reicht dafür: alles am
// Abreisetag oder davor ist Hinfahrt (die Heimladung am Vorabend gehört
// dazu), alles am Rückreisetag oder danach ist Rückfahrt.
// Pro Ladung überschreibbar – Vorschlag, kein Urteil.
export function suggestLeg(date, trip) {
  if (!date) return 'onsite';
  if (trip.dateStart && date <= trip.dateStart) return 'outbound';
  if (trip.dateEnd && date >= trip.dateEnd) return 'return';
  return 'onsite';
}

// Heimladung aus dem Ladefuchs-Bestand in die Trip-Sicht übersetzen.
// Bewusst eine Projektion, keine Kopie: die Quelle bleibt `charges[]`.
export function fromHomeCharge(c, trip) {
  return {
    id: c.id,
    provider: 'home',
    date: c.date,
    time: c.time || null,
    location: 'Daheim Wien',
    kwh: typeof c.kwh === 'number' ? c.kwh : null,
    grossTotal: typeof c.total === 'number' ? c.total : null,
    netTotal: null,
    grossPerKwh: typeof c.bruttoPerKwh === 'number' ? c.bruttoPerKwh : null,
    vatRate: null,
    leg: trip ? suggestLeg(c.date, trip) : 'outbound',
    estimated: false,
    isAggregate: false,
    isHome: true,
    dauer: c.dauer || null,
    snap: !!c.snap,
    needsReview: false,
    reviewReasons: [],
  };
}

// Geparste Rechnung → Trip-Ladung.
export function fromInvoiceCharge(c, trip) {
  return {
    ...c,
    leg: c.leg || (trip ? suggestLeg(c.date, trip) : 'onsite'),
    isHome: false,
  };
}

// Die tatsächlich verwendete Energiemenge. Beim Minutentarif steht auf der
// Rechnung keine – dann zählt der Schätzwert, falls einer gesetzt ist.
// Ohne beides bleibt es `null`: eine fehlende Menge ist keine Null.
export function effectiveKwh(charge) {
  if (typeof charge.kwh === 'number' && charge.kwh > 0) return charge.kwh;
  if (typeof charge.kwhEstimate === 'number' && charge.kwhEstimate > 0) return charge.kwhEstimate;
  return null;
}

export function isEstimatedKwh(charge) {
  return !(typeof charge.kwh === 'number' && charge.kwh > 0);
}

// Vorschlag für die Schätzung einer Minutentarif-Ladung.
export function estimateKwhFromMinutes(minutes, kw = DEFAULT_ESTIMATE_KW) {
  if (typeof minutes !== 'number' || minutes <= 0) return null;
  return round(minutes * (kw / 60), 1);
}
