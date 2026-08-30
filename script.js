// =====================================================================
// 🔥 FIREBASE CONFIG – HIER DEINE EIGENEN WERTE EINSETZEN
// =====================================================================
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyDkCyR1nFg38VvJi6POYzfVblRuV5OIvwM",
  authDomain: "wallbox-manuel.firebaseapp.com",
  projectId: "wallbox-manuel",
  storageBucket: "wallbox-manuel.firebasestorage.app",
  messagingSenderId: "547824093655",
  appId: "1:547824093655:web:05c57f3e9a810edcce6392"
};

// =====================================================================
// FIREBASE INIT (kein Login nötig – gemeinsamer Haushalt-Datensatz)
// =====================================================================
let db = null;
let firebaseReady = false;
const HOUSEHOLD_DOC = 'haushalt'; // Fixer Dokument-Name für euren Haushalt

try {
  if(FIREBASE_CONFIG.apiKey !== "DEIN_API_KEY") {
    firebase.initializeApp(FIREBASE_CONFIG);
    db = firebase.firestore();
    firebaseReady = true;
    db.enablePersistence({synchronizeTabs: true}).catch(err => {
      console.log('Firestore persistence error:', err.code);
    });
  }
} catch(e) {
  console.log('Firebase not configured, using localStorage only');
}

// =====================================================================
// WIENER NETZENTGELTE 2026 – Netzebene 7, ohne Leistungsmessung (Haushalt)
// Quelle: Wiener Netze Preisblätter, gültig ab 1.1.2026
// =====================================================================
const WIEN_TARIFFS = {
  netznutzung_arbeit: 0.0698,
  netzverlust: 0.0070,
  foerderbeitrag_arbeit: 0.00583,
  foerderbeitrag_nvl: 0.00037,
  elektrizitaetsabgabe: 0.001,
  gebrauchsabgabe_pct: 7.0,
  ust_pct: 20.0,
  netznutzung_grund_jahr: 54.00,
  foerderpauschale_jahr: 19.02,
  foerderbeitrag_grund_jahr: 3.796,
  snap_rabatt: 0.20, // Sommer-Nieder-Arbeitspreis: 20% Rabatt auf Netznutzung
};

// Sommer-Nieder-Arbeitspreis (SNAP): Apr–Sep, 10:00–16:00
// Prüft den Mittelpunkt der aktiven Ladezeit – mit anchor='end' (default: time = Ladeende,
// rechnet die halbe Dauer zurück) oder anchor='start' (time = Ladebeginn, rechnet vorwärts).
// Verhindert, dass Nachtladungen mit Abstecken am Vormittag fälschlich SNAP erhalten.
function isSnap(date, time, durationMs = 0, anchor = 'end') {
  if(!date || !time) return false;
  const [h, m] = time.split(':').map(Number);
  const anchorMin = h * 60 + (m || 0);
  const halfMin = Math.floor((durationMs || 0) / 60000 / 2);
  let checkMin = anchor === 'start' ? anchorMin + halfMin : anchorMin - halfMin;
  const checkDate = new Date(date);
  while(checkMin < 0)        { checkMin += 24 * 60; checkDate.setDate(checkDate.getDate() - 1); }
  while(checkMin >= 24 * 60) { checkMin -= 24 * 60; checkDate.setDate(checkDate.getDate() + 1); }
  const month = checkDate.getMonth(); // 0=Jan
  if(month < 3 || month > 8) return false; // Apr=3 … Sep=8
  return checkMin >= 10 * 60 && checkMin < 16 * 60;
}

// =====================================================================
// TARIF-HISTORIE – datumsabhängiger Energiepreis (netto)
// Anbieterwechsel (z.B. Wien Energie → Verbund) ändert nur den Energie-
// Arbeitspreis; Netzentgelte/Abgaben sind immer Wiener Netze.
// settings.tariffHistory: [{ from:'YYYY-MM-DD'|'', energy:Number, label:String }]
// `from` leer = „ab Beginn". Ohne passende Periode gilt settings.defaultEnergy.
// =====================================================================
function energyPriceFor(date) {
  const hist = settings.tariffHistory || [];
  if(!date || hist.length === 0) return settings.defaultEnergy;
  const match = hist
    .filter(t => typeof t.energy === 'number' && !isNaN(t.energy) && (t.from || '0000-01-01') <= date)
    .sort((a, b) => (a.from || '0000-01-01').localeCompare(b.from || '0000-01-01'))
    .pop();
  return match ? match.energy : settings.defaultEnergy;
}

// Lokales Datum als YYYY-MM-DD. NICHT toISOString() verwenden: das liefert UTC
// und damit zwischen 00:00 und 02:00 Wiener Zeit noch den Vortag – während
// toTimeString() lokal bleibt. Datum und Uhrzeit passten dann nicht zusammen.
function localDateStr(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// HH:MM:SS oder HH:MM in Millisekunden umrechnen (0 bei ungültigem Input)
function dauerToMs(dauer) {
  if(!dauer || typeof dauer !== 'string') return 0;
  const parts = dauer.split(':').map(Number);
  if(parts.some(isNaN)) return 0;
  if(parts.length === 3) return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
  if(parts.length === 2) return (parts[0] * 3600 + parts[1] * 60) * 1000;
  return 0;
}

// =====================================================================
// STATE
// =====================================================================
let charges = JSON.parse(localStorage.getItem('lf_charges') || '[]');
let settings = JSON.parse(localStorage.getItem('lf_settings') || 'null') || {
  defaultEnergy: 0.140118,
  tariffHistory: [],
  gebrauchsabgabe: WIEN_TARIFFS.gebrauchsabgabe_pct,
  ust: WIEN_TARIFFS.ust_pct,
  theme: 'light',
  comp_tesla_kwh: 0.48,
  comp_tesla_abo_jahr: 99.00,
  comp_tanke_kwh: 0.39,
  comp_tanke_zeit_min: 0.069,
  comp_tanke_zeit_abo_monat: 4.90,
  comp_benzin_verbrauch_l: 8.2,
  comp_ev_verbrauch_kwh: 20.0,
  comp_benzin_preis: 1.80,
  comp_wallbox_installation: 2685.40,
  goe_serial: '',
  goe_token: '',
};
settings = {
  tariffHistory: [],
  remindersDone: [],
  comp_tesla_kwh: 0.48,
  comp_tesla_abo_jahr: 99.00,
  comp_tanke_kwh: 0.39,
  comp_tanke_zeit_min: 0.069,
  comp_tanke_zeit_abo_monat: 4.90,
  comp_benzin_verbrauch_l: 8.2,
  comp_benzin_verbrauch_l_max: 9.5,
  comp_ev_verbrauch_kwh: 20.0,
  comp_benzin_preis: 1.80,
  comp_wallbox_installation: 2685.40,
  goe_serial: '',
  goe_token: '',
  ...settings,
};
let currentPeriod = 'month';

// =====================================================================
// AUFKLAPPBARE DASHBOARD-SEKTIONEN
// =====================================================================
// Zugeklappte Sektionen liegen in localStorage (`lf_collapsed`), bewusst NICHT
// in `settings`: das ist reiner Ansichtszustand dieses Geräts und hätte über
// syncToCloud() nichts in der Cloud verloren – am Handy will man andere
// Blöcke offen haben als am Desktop. Anders als `expandedMonths` überlebt es
// aber einen Reload, sonst klappt bei jedem Start alles wieder auf.
let collapsedSections = new Set(readCollapsed());

function readCollapsed() {
  try { return JSON.parse(localStorage.getItem('lf_collapsed') || '[]'); }
  catch (e) { return []; }
}

function saveCollapsed() {
  try { localStorage.setItem('lf_collapsed', JSON.stringify([...collapsedSections])); }
  catch (e) { /* Safari Private Mode – Zustand gilt dann nur für diese Sitzung */ }
}

// Kopf + Körper einer aufklappbaren Sektion. Der Zustand steckt als Klasse am
// Wrapper, damit toggleSection() ohne Neu-Rendern auskommt (die Sektionen
// werden von unterschiedlichen render*-Funktionen erzeugt).
function sectionShell(id, title, bodyHtml) {
  const collapsed = collapsedSections.has(id);
  return `
    <div class="collapse-section${collapsed ? ' is-collapsed' : ''}" id="sec-${id}">
      ${sectionHead(id, title, collapsed)}
      <div class="cs-body">${bodyHtml}</div>
    </div>`;
}

function sectionHead(id, title, collapsed) {
  return `<div class="section-title section-toggle" role="button" tabindex="0"
       aria-expanded="${!collapsed}"
       onclick="toggleSection('${id}')"
       onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();toggleSection('${id}');}">
    <span class="cs-chevron">▾</span><span>${title}</span>
  </div>`;
}

function toggleSection(id) {
  const el = document.getElementById('sec-' + id);
  if (!el) return;
  const collapsed = !collapsedSections.has(id);
  if (collapsed) collapsedSections.add(id); else collapsedSections.delete(id);
  el.classList.toggle('is-collapsed', collapsed);
  const head = el.querySelector('.section-toggle');
  if (head) head.setAttribute('aria-expanded', String(!collapsed));
  saveCollapsed();
}

// Sektionen, die fest im HTML stehen (statt von JS gerendert zu werden),
// bekommen ihren gespeicherten Zustand beim Start verpasst.
function applyCollapsedState() {
  document.querySelectorAll('.collapse-section').forEach(el => {
    const id = (el.id || '').replace(/^sec-/, '');
    const collapsed = collapsedSections.has(id);
    el.classList.toggle('is-collapsed', collapsed);
    const head = el.querySelector('.section-toggle');
    if (head) head.setAttribute('aria-expanded', String(!collapsed));
  });
}

// =====================================================================
// PERSIST (localStorage + Firestore)
// =====================================================================
function persist() {
  localStorage.setItem('lf_charges', JSON.stringify(charges));
  localStorage.setItem('lf_settings', JSON.stringify(settings));
  syncToCloud();
}

function applyTheme() {
  document.documentElement.setAttribute('data-theme', settings.theme === 'dark' ? 'dark' : 'light');
  const headerToggle = document.getElementById('theme-toggle-header');
  if (headerToggle) {
    headerToggle.checked = (settings.theme || 'light') === 'light';
  }
}

// =====================================================================
// E-CONTROL SPRITPREIS API – Median der günstigsten Tankstellen Wien
// =====================================================================
// Der Live-Preis wird bewusst NICHT in `settings` geschrieben:
// settings wird persistiert (localStorage + Firestore) und würde sonst den
// manuell hinterlegten Fallback-Preis dauerhaft überschreiben. Ausserdem
// würde das asynchrone loadFromCloud() den frisch geholten Wert je nach
// Reihenfolge wieder plattmachen.
let benzinPreisLive = null;      // Median aus der E-Control API (€/L)
let benzinPreisStatus = 'pending'; // 'pending' | 'live' | 'fallback'
let benzinPreisCount = 0;        // Anzahl Tankstellen im Median
let benzinPreisZeit = null;      // Zeitpunkt des Abrufs

// Effektiv verwendeter Benzinpreis: Live-Wert, sonst Wert aus den Einstellungen
function benzinPreis() {
  return benzinPreisLive !== null ? benzinPreisLive : settings.comp_benzin_preis;
}

// Badge-Text – macht sichtbar, WOHER der angezeigte Preis stammt
function benzinPreisLabel() {
  const wert = `ℹ️ Benzinpreis: ${fmt(benzinPreis(), 3)} €/L`;
  if (benzinPreisStatus === 'live') {
    const zeit = benzinPreisZeit
      ? benzinPreisZeit.toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' })
      : '';
    return `${wert} – Median der ${benzinPreisCount} günstigsten Tankstellen Wien `
      + `(E-Control, Super 95${zeit ? ', ' + zeit : ''})`;
  }
  if (benzinPreisStatus === 'pending') {
    return `${wert} – eigener Wert (E-Control wird geladen …)`;
  }
  return `${wert} – eigener Wert aus den Einstellungen (E-Control nicht erreichbar)`;
}

async function fetchBenzinpreis() {
  try {
    // includeClosed=true: sonst hängt der Median von der Uhrzeit ab
    // (nachts fallen die geschlossenen Tankstellen aus der Stichprobe).
    const url = 'https://api.e-control.at/sprit/1.0/search/gas-stations/by-address' +
      '?latitude=48.2082&longitude=16.3738&fuelType=SUP&includeClosed=true';
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const stations = await res.json();

    const prices = [];
    stations.forEach(s => {
      if (s.prices) {
        s.prices.forEach(p => {
          if (p.fuelType === 'SUP' && p.amount > 0) prices.push(p.amount);
        });
      }
    });

    if (prices.length === 0) throw new Error('keine Preise in der Antwort');

    prices.sort((a, b) => a - b);
    const mid = Math.floor(prices.length / 2);
    const median = prices.length % 2 !== 0
      ? prices[mid]
      : (prices[mid - 1] + prices[mid]) / 2;

    benzinPreisLive = Math.round(median * 1000) / 1000;
    benzinPreisCount = prices.length;
    benzinPreisZeit = new Date();
    benzinPreisStatus = 'live';
  } catch (e) {
    benzinPreisLive = null;
    benzinPreisStatus = 'fallback';
    console.log('E-Control API nicht erreichbar, Fallback auf gespeicherten Preis:', e.message);
  }
  refreshDashboard();
}

function setThemeFromToggle(isLight) {
  settings.theme = isLight ? 'light' : 'dark';
  applyTheme();
  persist();
}

async function syncToCloud() {
  if(!firebaseReady) return;
  setSyncStatus('syncing');
  try {
    await db.collection('haushalte').doc(HOUSEHOLD_DOC).set({
      charges: charges,
      settings: settings,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    setSyncStatus('online');
  } catch(e) {
    console.error('Sync error:', e);
    setSyncStatus('offline');
  }
}

function deduplicateCharges(arr) {
  // Zwei Keys parallel prüfen: date+time+kwh fängt Wallbox-Reboot-Duplikate
  // (gleiche Session, neuer lch) ab; lch fängt manuell editierte kWh-Werte ab.
  //
  // Die Uhrzeit MUSS Teil des Keys sein: ohne sie ist eine zweite echte Ladung
  // am selben Tag mit ähnlicher kWh-Menge (z.B. 12,00 früh / 12,04 abends) von
  // einem Duplikat nicht unterscheidbar und wird beim Start still gelöscht –
  // inkl. Rückschreiben in die Cloud, also unwiederbringlich.
  // Preis dafür: ein Reboot-Duplikat, dessen Zeitpunkt neu berechnet wurde,
  // rutscht durch. Das ist sichtbar und per Swipe oder „Duplikate entfernen"
  // korrigierbar – ein still gelöschter Eintrag nicht.
  const seen = new Set();
  return arr.filter(c => {
    const dateKwhKey = `dk_${c.date}_${c.time || '-'}_${Math.round((c.kwh ?? 0) * 10)}`;
    const lchKey = c.lch ? `lch_${c.lch}` : null;
    if (seen.has(dateKwhKey)) return false;
    if (lchKey && seen.has(lchKey)) return false;
    seen.add(dateKwhKey);
    if (lchKey) seen.add(lchKey);
    return true;
  });
}

async function loadFromCloud() {
  if(!firebaseReady) return;
  setSyncStatus('syncing');
  try {
    const doc = await db.collection('haushalte').doc(HOUSEHOLD_DOC).get();
    if(doc.exists) {
      const data = doc.data();
      if(data.settings) settings = {...settings, ...data.settings};
      if(data.charges && data.charges.length > 0) {
        const cloudIds = new Set(data.charges.map(c => c.id));
        const localOnlyEntries = charges.filter(c => !cloudIds.has(c.id));
        const merged = [...data.charges, ...localOnlyEntries];
        const deduped = deduplicateCharges(merged);
        deduped.sort((a,b) => b.date.localeCompare(a.date));
        charges = deduped;
        const needsWrite = localOnlyEntries.length > 0 || deduped.length < merged.length;
        if(needsWrite) {
          console.log(`Cloud sync: ${localOnlyEntries.length} lokal-only, ${merged.length - deduped.length} Duplikate entfernt → zurückschreiben`);
        }
        localStorage.setItem('lf_charges', JSON.stringify(charges));
        localStorage.setItem('lf_settings', JSON.stringify(settings));
        if(needsWrite) await syncToCloud();
      } else {
        localStorage.setItem('lf_charges', JSON.stringify(charges));
        localStorage.setItem('lf_settings', JSON.stringify(settings));
        await syncToCloud();
      }
    } else {
      await syncToCloud();
    }
    setSyncStatus('online');
  } catch(e) {
    console.error('Load error:', e);
    setSyncStatus('offline');
  }
}

function setSyncStatus(status) {
  const badge = document.getElementById('sync-badge');
  const label = document.getElementById('sync-label');
  badge.className = 'sync-badge ' + status;
  if(status === 'online') label.textContent = 'Cloud';
  else if(status === 'syncing') label.textContent = 'Sync...';
  else label.textContent = 'Lokal';
}

async function cleanupDuplicates() {
  const before = charges.length;
  charges = deduplicateCharges(charges);
  charges.sort((a,b) => b.date.localeCompare(a.date));
  const removed = before - charges.length;
  if(removed > 0) {
    localStorage.setItem('lf_charges', JSON.stringify(charges));
    await syncToCloud();
    toggleSettings();
    refreshDashboard();
    showToast(`${removed} Duplikat${removed !== 1 ? 'e' : ''} entfernt`);
  } else {
    showToast('Keine Duplikate gefunden');
  }
}

async function clearChargesOnly() {
  charges = [];
  localStorage.setItem('lf_charges', JSON.stringify([]));
  if (firebaseReady) {
    try {
      await db.collection('haushalte').doc(HOUSEHOLD_DOC).set(
        { charges: [], updatedAt: firebase.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      );
    } catch(e) { console.error(e); }
  }
  toggleSettings();
  refreshDashboard();
  showToast('Ladedaten gelöscht – Einstellungen beibehalten');
}

async function clearAllData() {
  if(firebaseReady) {
    try {
      await db.collection('haushalte').doc(HOUSEHOLD_DOC).delete();
    } catch(e) { console.error(e); }
  }
  localStorage.clear();
  location.reload();
}

// Einträge mit `dauer` neu prüfen: alte Einträge hatten SNAP nur an einem Zeitpunkt
// geprüft (z.B. go-e-auto Ladeende). Mittelpunkt-Berechnung kann den Status flippen.
async function migrateSnapTiming() {
  let changed = 0;
  for(const c of charges) {
    if(!c.dauer) continue;
    const ms = dauerToMs(c.dauer);
    if(!ms) continue;
    // go-e-auto: time = Ladeende → anchor 'end' (rückwärts zur Mitte)
    // go-e (CSV) und alle anderen: time = Ladebeginn → anchor 'start' (vorwärts zur Mitte)
    const anchor = c.source === 'go-e-auto' ? 'end' : 'start';
    const newSnap = isSnap(c.date, c.time, ms, anchor);
    if(newSnap === !!c.snap) continue;
    const r = calcTotal(c.kwh, c.energyPrice, newSnap);
    c.snap = newSnap;
    c.total = Math.round(r.total * 100) / 100;
    c.bruttoPerKwh = r.bruttoPerKwh;
    changed++;
  }
  if(changed > 0) {
    console.log(`SNAP-Migration: ${changed} Eintrag/Einträge korrigiert`);
    localStorage.setItem('lf_charges', JSON.stringify(charges));
    if(firebaseReady) await syncToCloud();
  }
}

// Energiepreis bestehender Ladungen an die Tarif-Historie angleichen (datumsabhängig).
// Manuell gesetzte Einzelpreise (priceManual) bleiben unangetastet.
async function migrateTariffPrices() {
  if(!settings.tariffHistory || settings.tariffHistory.length === 0) return;
  let changed = 0;
  for(const c of charges) {
    if(c.priceManual) continue;
    const ep = energyPriceFor(c.date);
    if(ep == null || Math.abs((c.energyPrice || 0) - ep) < 1e-9) continue;
    const r = calcTotal(c.kwh, ep, !!c.snap);
    c.energyPrice = ep;
    c.total = Math.round(r.total * 100) / 100;
    c.bruttoPerKwh = r.bruttoPerKwh;
    changed++;
  }
  if(changed > 0) {
    console.log(`Tarif-Migration: ${changed} Eintrag/Einträge angepasst`);
    localStorage.setItem('lf_charges', JSON.stringify(charges));
    if(firebaseReady) await syncToCloud();
  }
}

// Beim Start: Daten aus Cloud laden
if(firebaseReady) {
  loadFromCloud().then(async () => {
    await migrateSnapTiming();
    await migrateTariffPrices();
    applyTheme();
    initAddPage();
    refreshDashboard();
  });
} else {
  setSyncStatus('offline');
  migrateSnapTiming();
  migrateTariffPrices();
  applyTheme();
}

// =====================================================================
// CALCULATION
// =====================================================================
function calcTotal(kwh, energyPrice, snap = false) {
  const gab = settings.gebrauchsabgabe / 100;
  const ust = settings.ust / 100;

  // Variable Netzkosten pro kWh (netto); SNAP = 20% Rabatt auf Netznutzungsentgelt
  const netznutzung = WIEN_TARIFFS.netznutzung_arbeit * (snap ? (1 - WIEN_TARIFFS.snap_rabatt) : 1);
  const netz = netznutzung + WIEN_TARIFFS.netzverlust;
  const foerder = WIEN_TARIFFS.foerderbeitrag_arbeit + WIEN_TARIFFS.foerderbeitrag_nvl;
  const eAbgabe = WIEN_TARIFFS.elektrizitaetsabgabe;

  // Gebrauchsabgabe: 7% auf Energiekosten + Netzkosten (Netznutzung + Netzverlust)
  // NICHT auf Elektrizitätsabgabe, NICHT auf Förderbeitrag
  // Verifiziert gegen Wien Energie Jahresabrechnung 2026
  const gabBasis = energyPrice + netz;
  const gabPerKwh = gabBasis * gab;

  // Summe aller variablen Kosten pro kWh netto inkl. GAB
  const nettoTotalPerKwh = energyPrice + netz + gabPerKwh + foerder + eAbgabe;

  // Brutto (inkl. USt)
  const bruttoPerKwh = nettoTotalPerKwh * (1 + ust);

  const total = kwh * bruttoPerKwh;

  return {
    kwh, energyPrice, snap, total, bruttoPerKwh, netznutzung,
    breakdown: {
      energy: kwh * energyPrice,
      netznutzung: kwh * netznutzung,
      netzverlust: kwh * WIEN_TARIFFS.netzverlust,
      foerderbeitrag: kwh * (WIEN_TARIFFS.foerderbeitrag_arbeit + WIEN_TARIFFS.foerderbeitrag_nvl),
      eAbgabe: kwh * WIEN_TARIFFS.elektrizitaetsabgabe,
      gabBetrag: kwh * gabPerKwh,
      nettoGesamt: kwh * nettoTotalPerKwh,
      ust: kwh * nettoTotalPerKwh * ust,
      bruttoGesamt: total,
    }
  };
}

// =====================================================================
// SAVINGS CHIP – Ersparnis vs. günstigster Alternative pro Ladung
// =====================================================================
// Wallbox-Seite immer aus dem gespeicherten `c.total` – das trägt den Tarif und
// den SNAP-Status der jeweiligen Ladung. Vorher wurde hier mit
// settings.defaultEnergy und snap:false neu gerechnet, also mit dem HEUTIGEN
// Preis: alte Ladungen erschienen dadurch teurer als sie waren und der Chip
// widersprach der Detailansicht.
// Die Vergleichstarife (Tesla/Tanke) haben bewusst keine Historie – sie sind
// immer der aktuelle Stand aus den Einstellungen.
function calcSavingChip(c) {
  const kwh = c.kwh ?? 0;
  const costTesla = kwh * settings.comp_tesla_kwh;
  const costTanke = kwh * settings.comp_tanke_kwh;

  // Fallback für Altdaten ohne brauchbares total (z.B. total:null aus einem
  // früher leer gespeicherten Preisfeld)
  const wallbox = isFinite(c.total)
    ? c.total
    : calcTotal(kwh, energyPriceFor(c.date), !!c.snap).total;

  const savings = [
    { label: 'Tesla', saving: costTesla - wallbox },
    { label: 'Tanke', saving: costTanke - wallbox },
  ];

  return savings.reduce((a, b) => a.saving > b.saving ? a : b);
}

function savingChipHTML(c) {
  const best = calcSavingChip(c);
  if (best.saving <= 0) return '';
  return `<div class="tag saving-chip">
    <div class="tag-label">Ersparnis</div>
    <div class="tag-value" style="color:var(--green);font-size:11px;">${best.label}: +${fmt(best.saving)} €</div>
  </div>`;
}

// =====================================================================
// FORMAT HELPERS
// =====================================================================
const fmt = (n, d=2) => n.toLocaleString('de-AT', {minimumFractionDigits:d, maximumFractionDigits:d});
const fmtDate = (s) => {
  const d = new Date(s);
  return d.toLocaleDateString('de-AT', {day:'numeric', month:'short', year:'numeric'});
};
const fmtDateShort = (s) => {
  const d = new Date(s);
  return d.toLocaleDateString('de-AT', {day:'numeric', month:'short'});
};

// =====================================================================
// NAVIGATION
// =====================================================================
function showPage(name, btn) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-'+name).classList.add('active');
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  if(btn) btn.classList.add('active');
  else if(name !== 'detail') document.querySelector(`.nav-item[data-page="${name}"]`)?.classList.add('active');

  if(name === 'dashboard') refreshDashboard();
}

// =====================================================================
// ADD CHARGE PAGE
// =====================================================================
function initAddPage() {
  const now = new Date();
  const today = localDateStr(now);
  const nowTime = now.toTimeString().slice(0, 5);
  document.getElementById('inp-date').value = today;
  document.getElementById('inp-time').value = nowTime;
  document.getElementById('inp-energy').value = energyPriceFor(today);

  // Tariff breakdown info
  const tb = document.getElementById('tariff-breakdown');
  tb.innerHTML = `
    <div class="td-row"><span class="td-label">Netznutzungsentgelt</span><span class="td-value">${fmt(WIEN_TARIFFS.netznutzung_arbeit*100,2)} ct/kWh</span></div>
    <div class="td-row"><span class="td-label">Netzverlustentgelt</span><span class="td-value">${fmt(WIEN_TARIFFS.netzverlust*100,2)} ct/kWh</span></div>
    <div class="td-row"><span class="td-label">Erneuerbaren-Förderbeitrag</span><span class="td-value">${fmt((WIEN_TARIFFS.foerderbeitrag_arbeit+WIEN_TARIFFS.foerderbeitrag_nvl)*100,3)} ct/kWh</span></div>
    <div class="td-row"><span class="td-label">Elektrizitätsabgabe (Haushalt)</span><span class="td-value">${fmt(WIEN_TARIFFS.elektrizitaetsabgabe*100,1)} ct/kWh</span></div>
    <div class="td-row"><span class="td-label">Gebrauchsabgabe Wien</span><span class="td-value">${settings.gebrauchsabgabe}% v. Energie+Netz</span></div>
    <div class="td-row"><span class="td-label">USt</span><span class="td-value">${settings.ust}%</span></div>
    <div class="td-row" style="margin-top:8px;border-top:1px solid var(--border);padding-top:8px;">
      <span class="td-label" style="color:var(--text-muted);">Jährliche Fixkosten (Info)</span><span class="td-value" style="color:var(--text-muted);">${fmt(WIEN_TARIFFS.netznutzung_grund_jahr + WIEN_TARIFFS.foerderpauschale_jahr + WIEN_TARIFFS.foerderbeitrag_grund_jahr)} €</span>
    </div>
    <div class="td-row" style="margin-top:8px;border-top:1px solid var(--border);padding-top:8px;color:#16a34a;">
      <span class="td-label">☀️ Sommer-Nieder-Arbeitspreis</span><span class="td-value">–20% Netznutzung, Apr–Sep 10–16 Uhr</span>
    </div>
  `;

  updateCalc();
}

function updateCalc() {
  const kwh = parseFloat(document.getElementById('inp-kwh').value) || 0;
  const energy = parseFloat(document.getElementById('inp-energy').value);
  const date = document.getElementById('inp-date').value;
  const time = document.getElementById('inp-time').value;
  const snap = isSnap(date, time);
  const btn = document.getElementById('btn-save');

  // Leeres/ungültiges Preisfeld muss den Speichern-Button sperren: ein NaN-Preis
  // landet als total:null in Firestore und lässt fmt() beim Rendern werfen.
  if(kwh <= 0 || !isFinite(energy) || energy < 0) {
    document.getElementById('rc-total').textContent = '0,00';
    document.getElementById('rc-breakdown').innerHTML = '';
    document.getElementById('rc-snap').style.display = 'none';
    btn.disabled = true;
    return;
  }

  btn.disabled = false;
  const r = calcTotal(kwh, energy, snap);
  document.getElementById('rc-total').textContent = fmt(r.total);

  const snapEl = document.getElementById('rc-snap');
  if(snap) {
    const saving = kwh * WIEN_TARIFFS.netznutzung_arbeit * WIEN_TARIFFS.snap_rabatt * (1 + settings.gebrauchsabgabe / 100) * (1 + settings.ust / 100);
    snapEl.style.display = 'flex';
    snapEl.innerHTML = `<span>☀️</span><span>Sommer-Nieder-Arbeitspreis aktiv – Ersparnis: <strong>–${fmt(saving,2)} €</strong></span>`;
  } else {
    snapEl.style.display = 'none';
  }

  const bd = r.breakdown;
  document.getElementById('rc-breakdown').innerHTML = `
    <div class="rb-row"><span>Energie (${fmt(energy,4)} €/kWh)</span><span class="rb-val">${fmt(bd.energy)} €</span></div>
    <div class="rb-row"><span>Netznutzung (${fmt(r.netznutzung*100,2)} ct${snap ? ' ☀️ –20%' : ''})</span><span class="rb-val">${fmt(bd.netznutzung)} €</span></div>
    <div class="rb-row"><span>Netzverlust (0,70 ct)</span><span class="rb-val">${fmt(bd.netzverlust,3)} €</span></div>
    <div class="rb-row"><span>GAB ${settings.gebrauchsabgabe}% auf Energie+Netz</span><span class="rb-val">${fmt(bd.gabBetrag,3)} €</span></div>
    <div class="rb-row"><span>Förderbeitrag</span><span class="rb-val">${fmt(bd.foerderbeitrag,3)} €</span></div>
    <div class="rb-row"><span>Elektrizitätsabgabe</span><span class="rb-val">${fmt(bd.eAbgabe,3)} €</span></div>
    <div class="rb-row" style="font-weight:500;color:var(--text);"><span>Netto gesamt</span><span class="rb-val">${fmt(bd.nettoGesamt)} €</span></div>
    <div class="rb-row"><span>USt (${settings.ust}%)</span><span class="rb-val">${fmt(bd.ust)} €</span></div>
    <div class="rb-row rb-total"><span>Brutto gesamt</span><span class="rb-val">${fmt(bd.bruttoGesamt)} €</span></div>
  `;
}

['inp-kwh','inp-energy'].forEach(id => {
  document.getElementById(id).addEventListener('input', updateCalc);
});
// Datumswechsel zieht automatisch den passenden Energiepreis aus der Tarif-Historie
document.getElementById('inp-date').addEventListener('change', () => {
  document.getElementById('inp-energy').value = energyPriceFor(document.getElementById('inp-date').value);
  updateCalc();
});
document.getElementById('inp-time').addEventListener('change', updateCalc);

function saveCharge() {
  const kwh = parseFloat(document.getElementById('inp-kwh').value);
  const energy = parseFloat(document.getElementById('inp-energy').value);
  const date = document.getElementById('inp-date').value;
  const time = document.getElementById('inp-time').value;
  const snap = isSnap(date, time);

  if(!kwh || kwh <= 0) return;
  if(!isFinite(energy) || energy < 0) {
    showToast('Bitte einen gültigen Energiepreis eingeben');
    return;
  }

  const r = calcTotal(kwh, energy, snap);

  charges.push({
    id: Date.now().toString(36) + Math.random().toString(36).substr(2,4),
    date: date,
    time: time || null,
    snap: snap,
    kwh: kwh,
    energyPrice: energy,
    priceManual: Math.abs(energy - energyPriceFor(date)) > 1e-9,
    total: Math.round(r.total * 100) / 100,
    bruttoPerKwh: r.bruttoPerKwh,
    created: new Date().toISOString(),
  });

  charges.sort((a,b) => b.date.localeCompare(a.date));
  persist();

  showToast('Ladevorgang gespeichert!');
  document.getElementById('inp-kwh').value = '';
  updateCalc();
  showPage('dashboard');
}

// =====================================================================
// DASHBOARD
// =====================================================================
function refreshDashboard() {
  const now = new Date();
  let filtered = charges;
  let label = 'Gesamt';

  if(currentPeriod === 'month') {
    const m = now.getMonth(), y = now.getFullYear();
    filtered = charges.filter(c => { const d=new Date(c.date); return d.getMonth()===m && d.getFullYear()===y; });
    label = 'Dieser Monat';
  } else if(currentPeriod === 'year') {
    const y = now.getFullYear();
    filtered = charges.filter(c => new Date(c.date).getFullYear()===y);
    label = 'Dieses Jahr (' + now.getFullYear() + ')';
  }

  document.getElementById('dash-period-label').textContent = label;

  const totalCost = filtered.reduce((s,c) => s + c.total, 0);
  const totalKwh = filtered.reduce((s,c) => s + c.kwh, 0);
  const avgCost = totalKwh > 0 ? totalCost / totalKwh : 0;

  document.getElementById('dash-total').textContent = fmt(totalCost);
  document.getElementById('dash-kwh').textContent = fmt(totalKwh, 1);
  document.getElementById('dash-avg').textContent = fmt(avgCost, 2);

  // Last charge
  const lcArea = document.getElementById('last-charge-area');
  if(charges.length > 0) {
    const lc = charges[0];
    lcArea.innerHTML = `
      <div class="last-charge">
        <div class="lc-row">
          <div class="lc-info">
            <div class="lc-icon"><span class="material-symbols-outlined">bolt</span></div>
            <div class="lc-details">
              <div class="lc-title">Heimladung</div>
              <div class="lc-sub">${fmtDate(lc.date)}</div>
            </div>
          </div>
          <div class="lc-cost">
            <div class="amount">${fmt(lc.total)} €</div>
            <div class="kwh">+${fmt(lc.kwh,1)} kWh</div>
          </div>
        </div>
        <div class="lc-meta">
          <div class="tag"><div class="tag-label">Preis/kWh</div><div class="tag-value">${fmt(lc.bruttoPerKwh*100,1)} ct</div></div>
          <div class="tag"><div class="tag-label">Status</div><div class="tag-value" style="color:var(--green);white-space:nowrap;">● Abgeschlossen</div></div>
          ${lc.snap ? '<div class="tag"><div class="tag-label">Tarif</div><div class="tag-value" style="color:#16a34a;">☀️ SNAP –20%</div></div>' : ''}
          ${savingChipHTML(lc)}
        </div>
      </div>
    `;
  } else {
    lcArea.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">electric_car</span>Noch keine Ladevorgänge erfasst.</div>';
  }

  // History list
  const hlArea = document.getElementById('history-list');
  if(filtered.length > 0) {
    hlArea.innerHTML = filtered.map(c => `
      <div class="history-item-wrap" id="wrap-${c.id}">
        <div class="hi-delete-bg" onclick="askDelete('${c.id}', ${c.kwh}, '${c.date}')">
          <span class="material-symbols-outlined" style="font-size:20px;">delete</span>
          Löschen
        </div>
        <div class="history-item" id="hi-${c.id}" onclick="showDetail('${c.id}')">
          <div class="hi-left">
            <div class="hi-dot"></div>
            <div>
              <div class="hi-kwh">${fmt(c.kwh,1)} kWh</div>
              <div class="hi-date">${fmtDate(c.date)}</div>
            </div>
          </div>
          <div style="display:flex;align-items:center;">
            <div class="hi-right">
              <div class="hi-cost">${fmt(c.total)} €</div>
              <div class="hi-rate">${fmt(c.bruttoPerKwh*100,1)} ct/kWh${c.snap ? ' ☀️' : ''}</div>
              <div class="hi-saving">${(() => { const b = calcSavingChip(c); return b.saving > 0 ? `${b.label}: +${fmt(b.saving)} €` : ''; })()}</div>
            </div>
            <div class="hi-actions">
              <button class="hi-edit" onclick="event.stopPropagation(); openEdit('${c.id}')" title="Bearbeiten" aria-label="Ladevorgang bearbeiten">
                <span class="material-symbols-outlined" style="font-size:18px;">edit</span>
              </button>
              <button class="hi-del" onclick="event.stopPropagation(); askDelete('${c.id}', ${c.kwh}, '${c.date}')" title="Löschen" aria-label="Ladevorgang löschen">
                <span class="material-symbols-outlined" style="font-size:18px;">delete</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    `).join('');

    // Init swipe on all items
    filtered.forEach(c => initSwipe(c.id));
  } else {
    hlArea.innerHTML = '<div class="empty-state" style="padding:24px;">Keine Einträge im gewählten Zeitraum.</div>';
  }

  // Chart
  renderPeakChart(filtered);
  renderKwhChart(filtered);
  renderReminders();
  renderInsights();
  renderSavings();
  renderAmortisation();
  renderMonthStats();
}

let pendingDeleteId = null;

function askDelete(id, kwh, date) {
  pendingDeleteId = id;
  document.getElementById('confirm-detail').textContent =
    `${fmt(kwh,1)} kWh vom ${fmtDate(date)} wird gelöscht.`;
  document.getElementById('confirm-delete').classList.add('show');
}

function cancelDelete() {
  pendingDeleteId = null;
  document.getElementById('confirm-delete').classList.remove('show');
  // Reset any swiped items
  document.querySelectorAll('.history-item.swiped').forEach(el => el.classList.remove('swiped'));
}

function confirmDelete() {
  if(!pendingDeleteId) return;
  const wrap = document.getElementById('wrap-' + pendingDeleteId);
  const item = document.getElementById('hi-' + pendingDeleteId);

  document.getElementById('confirm-delete').classList.remove('show');

  // Animate out
  if(item) item.classList.add('deleting');
  if(wrap) {
    wrap.style.transition = 'max-height 0.35s ease, opacity 0.3s ease';
    wrap.style.maxHeight = wrap.offsetHeight + 'px';
    requestAnimationFrame(() => {
      wrap.style.maxHeight = '0';
      wrap.style.opacity = '0';
      wrap.style.overflow = 'hidden';
    });
  }

  setTimeout(() => {
    charges = charges.filter(c => c.id !== pendingDeleteId);
    pendingDeleteId = null;
    persist();
    refreshDashboard();
    showToast('Eintrag gelöscht');
  }, 350);
}

// Swipe-to-delete touch handling
function initSwipe(id) {
  const el = document.getElementById('hi-' + id);
  if(!el) return;

  let startX = 0, startY = 0, currentX = 0;
  let isDragging = false, directionLocked = false, isHorizontal = false;
  const DIR_LOCK_PX = 10;  // px before direction is decided
  const SNAP_PX = 100;     // px to snap into swiped state

  el.addEventListener('touchstart', e => {
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    currentX = startX;
    isDragging = true;
    directionLocked = false;
    isHorizontal = false;
    el.style.transition = 'none';
  }, {passive:true});

  el.addEventListener('touchmove', e => {
    if(!isDragging) return;
    const dx = e.touches[0].clientX - startX;
    const dy = e.touches[0].clientY - startY;
    currentX = e.touches[0].clientX;

    if(!directionLocked) {
      if(Math.abs(dx) < DIR_LOCK_PX && Math.abs(dy) < DIR_LOCK_PX) return;
      directionLocked = true;
      isHorizontal = Math.abs(dx) > Math.abs(dy) * 1.5;
    }

    if(!isHorizontal) return;

    const diff = startX - currentX;
    if(diff > 0) {
      el.style.transform = `translateX(${-Math.min(diff, 120)}px)`;
    } else {
      el.style.transform = 'translateX(0)';
    }
  }, {passive:true});

  el.addEventListener('touchend', () => {
    isDragging = false;
    if(!isHorizontal) return;
    el.style.transition = 'transform 0.3s ease';
    const diff = startX - currentX;
    if(diff > SNAP_PX) {
      el.classList.add('swiped');
      el.style.transform = '';
    } else {
      el.classList.remove('swiped');
      el.style.transform = 'translateX(0)';
    }
  }, {passive:true});
}

// Close swiped items when tapping elsewhere
document.addEventListener('touchstart', e => {
  if(!e.target.closest('.history-item-wrap')) {
    document.querySelectorAll('.history-item.swiped').forEach(el => {
      el.classList.remove('swiped');
      el.style.transform = 'translateX(0)';
    });
  }
}, {passive:true});

// =====================================================================
// INSIGHTS
// =====================================================================
function renderInsights() {
  const area = document.getElementById('insight-area');
  if(charges.length === 0) {
    area.innerHTML = '';
    return;
  }

  const now = new Date();
  const thisMonth = now.getMonth(), thisYear = now.getFullYear();
  const thisMonthCharges = charges.filter(c => { const d=new Date(c.date); return d.getMonth()===thisMonth && d.getFullYear()===thisYear; });
  const thisMonthKwh = thisMonthCharges.reduce((s,c) => s + c.kwh, 0);

  // Previous month
  const prevDate = new Date(thisYear, thisMonth - 1, 1);
  const prevMonth = prevDate.getMonth(), prevYear = prevDate.getFullYear();
  const prevMonthCharges = charges.filter(c => { const d=new Date(c.date); return d.getMonth()===prevMonth && d.getFullYear()===prevYear; });
  const prevMonthKwh = prevMonthCharges.reduce((s,c) => s + c.kwh, 0);

  const insights = [];

  // Month comparison
  if(prevMonthKwh > 0 && thisMonthKwh > 0) {
    const pct = ((thisMonthKwh - prevMonthKwh) / prevMonthKwh * 100);
    if(pct > 0) {
      insights.push(`<span class="insight-highlight">+${fmt(pct,0)}%</span> mehr geladen als letzten Monat`);
    } else if(pct < 0) {
      insights.push(`<span class="insight-highlight">${fmt(pct,0)}%</span> weniger geladen als letzten Monat`);
    } else {
      insights.push(`Gleich viel geladen wie letzten Monat`);
    }
  } else if(thisMonthCharges.length > 0 && prevMonthKwh === 0) {
    insights.push(`<span class="insight-highlight">${fmt(thisMonthKwh,0)} kWh</span> diesen Monat geladen`);
  }

  // SNAP savings
  const snapCharges = charges.filter(c => c.snap);
  if(snapCharges.length > 0) {
    const snapSavings = snapCharges.reduce((s, c) => {
      return s + c.kwh * WIEN_TARIFFS.netznutzung_arbeit * WIEN_TARIFFS.snap_rabatt * (1 + settings.gebrauchsabgabe / 100) * (1 + settings.ust / 100);
    }, 0);
    insights.push(`☀️ Sommer-Nieder-Tarif: <span class="insight-highlight">–${fmt(snapSavings,2)} €</span> gespart (${snapCharges.length} Ladung${snapCharges.length !== 1 ? 'en' : ''})`);
  }

  // Total charges count
  if(charges.length >= 2 && insights.length === 0) {
    insights.push(`<span class="insight-highlight">${charges.length}</span> Ladevorgänge erfasst`);
  }

  // First data
  if(charges.length === 1) {
    insights.push(`Erste Ladung erfasst – weiter so!`);
  }

  if(insights.length > 0) {
    area.innerHTML = insights.map(text => `
      <div class="insight-card">
        <span class="insight-icon">💡</span>
        <div class="insight-text">${text}</div>
      </div>
    `).join('');
  } else {
    area.innerHTML = '';
  }
}

function setPeriod(p, btn) {
  currentPeriod = p;
  document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  refreshDashboard();
}

// =====================================================================
// CHART
// =====================================================================
// Schwelle der SNE-G-V auf Netzebene 7: bis hier gilt der niedrigere
// Leistungspreis, darüber der höhere.
const PEAK_THRESHOLD_KW = 10;

// =====================================================================
// TARIF-ERINNERUNGEN
// Die Tarifgrössen stehen als Konstanten in WIEN_TARIFFS und müssen zu
// bestimmten Stichtagen von Hand nachgezogen werden. Damit das nicht
// untergeht, blendet das Dashboard ab dem jeweiligen Datum einen Hinweis
// ein, bis er quittiert wird.
//
// `from` ist der Stichtag, ab dem der Hinweis erscheint – nicht das Datum,
// an dem die Änderung gilt. Beim Leistungspreis fällt beides zusammen,
// bei WiNAP wird bewusst früher erinnert (die Beträge stehen dann schon
// fest, und der erste Winterzeitraum beginnt am 1.10.).
// =====================================================================
const TARIFF_REMINDERS = [
  {
    id: 'sne-tv-2027',
    from: '2027-01-01',
    title: 'Neue Netzentgelte ab 1.1.2027',
    text: 'Die SNE-T-V ist in Kraft. In <strong>WIEN_TARIFFS</strong> gehören jetzt die neuen Wiener-Netze-Werte: '
        + 'Netznutzung Arbeitspreis, Netzverlust, Grundpauschale – und neu der <strong>Leistungspreis</strong> '
        + '(€/kW auf das höchste 15-Minuten-Mittel des Monats, gestaffelt an der 10-kW-Grenze). '
        + 'Der Leistungspreis fehlt in der Kostenrechnung dieser App noch komplett.',
  },
  {
    id: 'winap-2027',
    from: '2027-01-01',
    title: 'WiNAP umsetzen (TODO 5)',
    text: 'Der <strong>Winter-Nieder-Arbeitspreis</strong> (Okt–Mär, 22:00–04:00) ist das Gegenstück zu SNAP. '
        + '<strong>Erst prüfen, ab wann er greift</strong>: die Verordnung gilt ab 1.1.2027, in der Begutachtung '
        + 'stand aber der Vorschlag, ihn erstmals mit dem Winterzeitraum ab 1.10.2027 anzuwenden. '
        + 'Danach: Rabattsatz eintragen, <code>isWinap()</code> analog <code>isSnap()</code> bauen – '
        + 'und im Auto-Import <code>goe-import.js</code> mitgeben, der eine eigene Kopie der Logik hat.',
  },
];

function dueReminders() {
  const today = new Date().toISOString().slice(0, 10);
  const done = settings.remindersDone || [];
  return TARIFF_REMINDERS.filter(r => r.from <= today && !done.includes(r.id));
}

function renderReminders() {
  const area = document.getElementById('reminder-area');
  if(!area) return;
  const due = dueReminders();
  area.innerHTML = due.map(r => `
    <div class="reminder">
      <div class="rm-head">
        <span class="material-symbols-outlined rm-icon">campaign</span>
        <span class="rm-title">${r.title}</span>
      </div>
      <div class="rm-text">${r.text}</div>
      <button class="rm-btn" onclick="dismissReminder('${r.id}')">Erledigt – nicht mehr anzeigen</button>
    </div>`).join('');
}

function dismissReminder(id) {
  if(!settings.remindersDone) settings.remindersDone = [];
  if(!settings.remindersDone.includes(id)) settings.remindersDone.push(id);
  persist();
  renderReminders();
  showToast('Hinweis ausgeblendet');
}

function renderPeakChart(data) {
  const area = document.getElementById('peak-chart-area');
  const badge = document.getElementById('peak-badge');
  if(!area) return;

  // Peak je Monat = höchstes maxKw. Einträge ohne Wert (alte go-e-Auto-Importe
  // vor dem Peak-Tracker) zählen NICHT als 0 – sonst behauptet das Diagramm,
  // in dem Monat sei kaum Leistung geflossen.
  const byMonth = {};
  data.forEach(c => {
    const key = c.date.slice(0, 7);
    if(!byMonth[key]) byMonth[key] = { peak: 0, known: 0, total: 0 };
    byMonth[key].total++;
    if(c.maxKw > 0) {
      byMonth[key].known++;
      if(c.maxKw > byMonth[key].peak) byMonth[key].peak = c.maxKw;
    }
  });

  const keys = Object.keys(byMonth).sort();
  if(keys.length === 0) {
    area.innerHTML = '<div class="pc-empty">Keine Daten</div>';
    if(badge) badge.textContent = '';
    return;
  }

  const peaks = keys.map(k => byMonth[k].peak).filter(v => v > 0);
  if(peaks.length === 0) {
    area.innerHTML = '<div class="pc-empty">Noch keine Leistungswerte – CSV importieren oder auf die nächste Ladung warten</div>';
    if(badge) badge.textContent = '';
    return;
  }

  // Skala immer bis mindestens 11 kW, damit die 10-kW-Linie nicht am Rand klebt.
  const scaleMax = Math.max(11, Math.ceil(Math.max(...peaks)));
  const pct = v => (v / scaleMax) * 100;

  const bars = keys.map(k => {
    const m = byMonth[k];
    const h = pct(m.peak);
    const over = m.peak > PEAK_THRESHOLD_KW;
    const partial = m.known < m.total;
    const label = new Date(parseInt(k.slice(0,4)), parseInt(k.slice(5,7)) - 1, 1)
      .toLocaleDateString('de-AT', { month: 'short' });
    if(m.peak === 0) {
      return `<div class="pc-col"><span class="pc-val pc-val-none">—</span>
        <div class="pc-bar pc-bar-none"></div><span class="pc-label">${label}</span></div>`;
    }
    return `
      <div class="pc-col">
        <span class="pc-val${over ? ' is-over' : ''}" style="bottom:calc(${h}% + 4px)">${fmt(m.peak, 2)}${partial ? '*' : ''}</span>
        <div class="pc-bar${over ? ' is-over' : ''}" style="height:${h}%"></div>
        <span class="pc-label">${label}</span>
      </div>`;
  }).join('');

  const anyPartial = keys.some(k => byMonth[k].known > 0 && byMonth[k].known < byMonth[k].total);

  area.innerHTML = `
    <div class="peak-chart">
      <div class="pc-plot">
        <div class="pc-threshold" style="bottom:${pct(PEAK_THRESHOLD_KW)}%">
          <span class="pc-threshold-tag">${PEAK_THRESHOLD_KW} kW</span>
        </div>
        <div class="pc-bars">${bars}</div>
      </div>
    </div>
    ${anyPartial ? '<div class="pc-note">* nicht alle Ladungen des Monats haben einen Leistungswert</div>' : ''}`;

  const overCount = keys.filter(k => byMonth[k].peak > PEAK_THRESHOLD_KW).length;
  const withData = keys.filter(k => byMonth[k].peak > 0).length;
  if(badge) {
    badge.textContent = overCount > 0
      ? `${overCount}/${withData} Monate über ${PEAK_THRESHOLD_KW} kW`
      : `alle unter ${PEAK_THRESHOLD_KW} kW`;
    badge.classList.toggle('badge-warn', overCount > 0);
  }
}

// =====================================================================
// KWH JE MONAT (Balken) – nur in Jahres- und Gesamt-Übersicht
// =====================================================================
// Anders als beim Peak-Diagramm sind Lücken hier eine echte Aussage: ein Monat
// ohne Ladung hat 0 kWh (kein fehlender Messwert). Deshalb wird die Zeitachse
// lückenlos aufgefüllt – sonst rücken zwei Monate nebeneinander, zwischen
// denen ein halbes Jahr liegt.
const KWH_CHART_MAX_MONTHS = 24;

function monthKeysBetween(from, to) {
  const keys = [];
  let y = parseInt(from.slice(0, 4)), m = parseInt(from.slice(5, 7));
  const yEnd = parseInt(to.slice(0, 4)), mEnd = parseInt(to.slice(5, 7));
  while (y < yEnd || (y === yEnd && m <= mEnd)) {
    keys.push(`${y}-${String(m).padStart(2, '0')}`);
    if (++m > 12) { m = 1; y++; }
  }
  return keys;
}

function renderKwhChart(data) {
  const area = document.getElementById('kwh-chart-area');
  if (!area) return;

  if (currentPeriod === 'month' || data.length === 0) { area.innerHTML = ''; return; }

  const byMonth = {};
  data.forEach(c => {
    const key = c.date.slice(0, 7);
    if (!byMonth[key]) byMonth[key] = { kwh: 0, count: 0 };
    byMonth[key].kwh += c.kwh;
    byMonth[key].count++;
  });

  const present = Object.keys(byMonth).sort();
  const nowKey = new Date().toISOString().slice(0, 7);
  const last = present[present.length - 1];
  let keys = monthKeysBetween(present[0], last > nowKey ? last : nowKey);

  // Bei sehr langer Historie werden die Balken sonst zu Strichen.
  const truncated = keys.length > KWH_CHART_MAX_MONTHS;
  if (truncated) keys = keys.slice(-KWH_CHART_MAX_MONTHS);

  const maxKwh = Math.max(...keys.map(k => (byMonth[k] ? byMonth[k].kwh : 0)));
  if (maxKwh <= 0) { area.innerHTML = ''; return; }

  // Ab 13 Balken haben die Werte über den Säulen keinen Platz mehr; dann nur
  // noch jedes dritte Monatslabel (plus Jahreswechsel) und Werte per Tooltip.
  const dense = keys.length > 12;
  const janIdx = new Set(keys.map((k, i) => (k.slice(5) === '01' ? i : -1)).filter(i => i >= 0));

  const bars = keys.map((k, i) => {
    const kwh = byMonth[k] ? byMonth[k].kwh : 0;
    const h = (kwh / maxKwh) * 100;
    const d = new Date(parseInt(k.slice(0, 4)), parseInt(k.slice(5, 7)) - 1, 1);
    const short = d.toLocaleDateString('de-AT', { month: 'short' });
    const isJan = k.slice(5) === '01';
    // Neben einem Jahreswechsel-Label ('Jän 26') ist kein Platz mehr – dort
    // fällt das Raster-Label weg, sonst überlappen die beiden.
    const showLabel = !dense || isJan
      || (!janIdx.has(i - 1) && !janIdx.has(i + 1) && (i % 3 === 0 || i === keys.length - 1));
    const label = isJan && dense ? `${short} ${k.slice(2, 4)}` : short;
    const count = byMonth[k] ? byMonth[k].count : 0;
    const title = `${d.toLocaleDateString('de-AT', { month: 'long', year: 'numeric' })}: ${fmt(kwh, 1)} kWh`
      + ` (${count} Ladung${count !== 1 ? 'en' : ''})`;
    return `
      <div class="kc-col" title="${title}">
        ${dense || kwh === 0 ? '' : `<span class="kc-val" style="bottom:calc(${h}% + 4px)">${fmt(kwh, 0)}</span>`}
        <div class="kc-bar${kwh === 0 ? ' kc-bar-none' : ''}" style="${kwh === 0 ? '' : `height:${h}%`}"></div>
        ${showLabel ? `<span class="kc-label">${label}</span>` : ''}
      </div>`;
  }).join('');

  const totalKwh = keys.reduce((sum, k) => sum + (byMonth[k] ? byMonth[k].kwh : 0), 0);
  const avg = totalKwh / keys.length;

  area.innerHTML = sectionShell('kwhchart', '🔋 Geladene Energie / Monat', `
    <div class="chart-container">
      <div class="chart-header">
        <span style="font-size:12px;color:var(--text-secondary)">Ø ${fmt(avg, 1)} kWh pro Monat</span>
        <span class="badge">${fmt(totalKwh, 0)} kWh gesamt</span>
      </div>
      <div class="kwh-chart">
        <div class="kc-plot"><div class="kc-bars">${bars}</div></div>
      </div>
      ${truncated ? `<div class="kc-note">nur die letzten ${KWH_CHART_MAX_MONTHS} Monate</div>` : ''}
    </div>`);
}

// =====================================================================
// CSV IMPORT
// =====================================================================
function initImport() {
  const dz = document.getElementById('drop-zone');
  const fi = document.getElementById('file-input');

  ['dragenter','dragover'].forEach(e => dz.addEventListener(e, ev => { ev.preventDefault(); dz.classList.add('drag-over'); }));
  ['dragleave','drop'].forEach(e => dz.addEventListener(e, ev => { ev.preventDefault(); dz.classList.remove('drag-over'); }));

  dz.addEventListener('drop', ev => {
    const file = ev.dataTransfer.files[0];
    if(file) processFile(file);
  });

  fi.addEventListener('change', ev => {
    const file = ev.target.files[0];
    if(file) processFile(file);
  });
}

// =====================================================================
// go-e CSV – zwei Export-Varianten
//
// A) App-Export ("EnergieReport.csv"): Komma-getrennt, Spalten "Maximale
//    Leistung" / "Gesamtzeit" / "Ladezeit", Dauer als "17H 43min 18S" bzw.
//    "1T 9H 59min 49S", und ein Header, der wegen eines gequoteten Feldes
//    ("Zähler\ndifferenz") über ZWEI Zeilen geht.
// B) data.v3.go-e.io: Semikolon-getrennt, jedes Feld in "…", Dezimalkomma,
//    Spalten "max. Leistung [kW]" / "Dauer gesamt", Dauer als "HH:MM:SS".
//
// Ein zeilenweises split() reicht für keine der beiden: bei A zerreisst es den
// Header, bei B bleiben die Quotes an den Werten kleben (parseFloat('"72.324"')
// ist NaN) und am Spaltennamen ('"start"' !== 'start').
// =====================================================================
function parseCsv(text, delim) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  const src = text.replace(/\r/g, '');
  for(let i = 0; i < src.length; i++) {
    const ch = src[i];
    if(inQuotes) {
      if(ch === '"') { if(src[i+1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += ch;
    }
    else if(ch === '"') inQuotes = true;
    else if(ch === delim) { row.push(field); field = ''; }
    else if(ch === '\n') { row.push(field); field = ''; if(row.some(f => f.trim() !== '')) rows.push(row); row = []; }
    else field += ch;
  }
  row.push(field);
  if(row.some(f => f.trim() !== '')) rows.push(row);
  return rows;
}

// Trennzeichen raten: das Zeichen, das in der Kopfzeile die meisten Felder ergibt.
function detectDelim(text) {
  return [';', ',', '\t']
    .map(d => ({ d, n: (parseCsv(text, d)[0] || []).length }))
    .sort((a, b) => b.n - a.n)[0].d;
}

const normHeader = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();

// Erste passende Spalte aus mehreren Namensvarianten.
function findCol(cols, ...tests) {
  for(const t of tests) { const i = cols.findIndex(t); if(i >= 0) return i; }
  return -1;
}

// Dezimalkomma (data.v3) oder Dezimalpunkt (App-Export) – nie beides zugleich.
function parseNum(raw) {
  const s = (raw || '').trim();
  if(!s) return NaN;
  return parseFloat(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s);
}

const secToDauer = sec =>
  Math.floor(sec/3600) + ':' + String(Math.floor((sec%3600)/60)).padStart(2,'0') + ':' + String(sec%60).padStart(2,'0');

// "HH:MM:SS" (auch >24h), "17H 43min 18S", "1T 9H 59min 49S", "47min 58S", "21S"
function normDauer(raw) {
  const s = (raw || '').trim();
  if(!s) return null;
  if(s.includes(':')) {
    const p = s.split(':').map(Number);
    if(p.some(isNaN)) return null;
    const sec = p.length === 3 ? p[0]*3600 + p[1]*60 + p[2] : p.length === 2 ? p[0]*60 + p[1] : 0;
    return sec > 0 ? secToDauer(sec) : null;
  }
  const m = s.match(/^(?:(\d+)\s*T)?\s*(?:(\d+)\s*H)?\s*(?:(\d+)\s*min)?\s*(?:(\d+)\s*S)?$/i);
  if(!m) return null;
  const sec = (+m[1]||0)*86400 + (+m[2]||0)*3600 + (+m[3]||0)*60 + (+m[4]||0);
  return sec > 0 ? secToDauer(sec) : null;
}

// "06.08.2026 15:31:22" → { date:'2026-08-06', time:'15:31', ms }
function goeDateTime(raw) {
  const [d, t] = (raw || '').trim().split(' ');
  const p = (d || '').split('.');
  if(p.length !== 3) return null;
  const year = p[2].length === 2 ? '20' + p[2] : p[2];
  const date = `${year}-${p[1].padStart(2,'0')}-${p[0].padStart(2,'0')}`;
  const time = t ? t.slice(0, 5) : '';
  return { date, time, ms: Date.parse(`${date}T${time || '00:00'}:00`) };
}

// Zuordnung CSV-Zeile → bestehende Ladung.
// Die Uhrzeit taugt nicht als Schlüssel: die CSV speichert den Steckbeginn, der
// go-e-Auto-Import den Ladeschluss – und mehr als die Hälfte der Sessions endet
// an einem anderen Kalendertag, als sie beginnt. Ein date-Vergleich (wie vorher)
// legt deshalb Duplikate an, statt die Zeile als bekannt zu erkennen.
// kWh ist der starke Schlüssel. Bei mehreren Kandidaten (77,089 vs 77,086 liegen
// 0,003 auseinander) entscheidet die Nähe zum Ladeende – aber nur, wenn der
// Zweitbeste eindeutig weit weg ist.
function matchExistingCharge(kwh, endeMs) {
  const cand = charges.filter(c => Math.abs((c.kwh ?? 0) - kwh) < 0.01);
  if(cand.length === 0) return null;
  const dist = c => Math.abs(Date.parse(`${c.date}T${c.time || '12:00'}:00`) - endeMs);
  if(!isFinite(endeMs)) return cand.length === 1 ? cand[0] : null;
  const sorted = cand.slice().sort((a,b) => dist(a) - dist(b));
  if(dist(sorted[0]) > 48*3600*1000) return null;   // zu weit weg → echte neue Ladung
  if(sorted[1] && dist(sorted[1]) <= 24*3600*1000) return null; // nicht eindeutig
  return sorted[0];
}

let importPreview = []; // Temporary storage for CSV preview
let importBackfill = []; // Bestehende Ladungen, die nur ergänzt werden

function processFile(file) {
  const reader = new FileReader();
  reader.onload = e => {
    const text = e.target.result;
    importPreview = [];
    importBackfill = [];

    if(file.name.endsWith('.json')) {
      try {
        const data = JSON.parse(text);
        const arr = Array.isArray(data) ? data : [data];
        arr.forEach(item => {
          if(item.date && item.kwh) {
            // priceManual nur setzen, wenn tatsächlich eine gültige Zahl kam –
            // sonst ist der Eintrag dauerhaft von migrateTariffPrices() ausgenommen,
            // obwohl nie ein Preis gesetzt wurde.
            const epRaw = parseFloat(item.energy_price ?? item.energyPrice);
            const epManual = isFinite(epRaw) && epRaw >= 0;
            const ep = epManual ? epRaw : energyPriceFor(item.date);
            const exists = charges.some(c => c.date === item.date && Math.abs(c.kwh - item.kwh) < 0.01);
            if(exists) return;
            const r = calcTotal(item.kwh, ep);
            importPreview.push({
              id: Date.now().toString(36) + Math.random().toString(36).substr(2,4),
              date: item.date, kwh: item.kwh, energyPrice: ep, priceManual: epManual,
              total: Math.round(r.total*100)/100, bruttoPerKwh: r.bruttoPerKwh,
              created: new Date().toISOString(),
            });
          }
        });
      } catch(err) { showToast('Fehler beim Parsen der JSON-Datei'); return; }
    } else {
      const lines = text.trim().replace(/\r/g, '').split('\n');
      const csvRows = parseCsv(text, detectDelim(text));
      const cols = (csvRows[0] || []).map(normHeader);
      const iStart = findCol(cols, c => c === 'start');
      const iEnde = findCol(cols, c => c === 'ende');
      // "energie pv"/"energie akku" dürfen die Energiespalte nicht kapern.
      const iKwh = findCol(cols,
        c => c === 'energie [kwh]', c => c === 'energie',
        c => c.startsWith('energie') && !c.includes('pv') && !c.includes('akku'));
      const iMaxKw = findCol(cols, c => c.startsWith('max') && c.includes('leistung'));
      const iDauer = findCol(cols, c => c.includes('dauer gesamt'), c => c === 'gesamtzeit');
      const iDauerAktiv = findCol(cols, c => c.includes('dauer aktiver stromfluss'), c => c === 'ladezeit');
      const isGoE = iStart >= 0 && iKwh >= 0;

      // Nur bei eindeutigen go-e-Merkmalen abbrechen – eine generische CSV mit
      // einer Spalte "energie" soll weiterhin im generischen Zweig landen.
      if(!isGoE && /session (number|id|identifier)|energie \[kwh\]/.test(cols.join('|'))) {
        showToast('go-e CSV erkannt, aber Spalten fehlen');
        return;
      }

      if(isGoE) {
        for(let i = 1; i < csvRows.length; i++) {
          const parts = csvRows[i];
          if(parts.length < Math.max(iStart, iKwh) + 1) continue;
          const start = goeDateTime(parts[iStart]);
          if(!start) continue;
          const date = start.date;
          const time = start.time;
          const kwh = parseNum(parts[iKwh]);
          if(isNaN(kwh) || kwh <= 0) continue;
          const maxKwRaw = iMaxKw >= 0 ? parseNum(parts[iMaxKw]) : NaN;
          const maxKw = isFinite(maxKwRaw) && maxKwRaw > 0 ? maxKwRaw : null;
          const dauerGesamt = iDauer >= 0 ? normDauer(parts[iDauer]) : null;
          const dauer = iDauerAktiv >= 0 ? normDauer(parts[iDauerAktiv]) : null;

          // Bereits bekannte Session → nicht neu anlegen, sondern fehlende
          // Felder ergänzen. Bestehende Werte werden nie überschrieben.
          const ende = iEnde >= 0 ? goeDateTime(parts[iEnde]) : null;
          const existing = matchExistingCharge(kwh, ende ? ende.ms : NaN);
          if(existing) {
            const patch = {};
            if(maxKw !== null && !(existing.maxKw > 0)) patch.maxKw = maxKw;
            if(dauerGesamt && !existing.dauerGesamt) patch.dauerGesamt = dauerGesamt;
            if(dauer && !existing.dauer) patch.dauer = dauer;
            if(Object.keys(patch).length) {
              importBackfill.push({ id: existing.id, date: existing.date, kwh: existing.kwh, patch });
            }
            continue;
          }
          // CSV-Start = Steckbeginn → SNAP-Mittelpunkt ab Start vorwärts berechnen
          const snap = isSnap(date, time, dauerToMs(dauer), 'start');
          const ep = energyPriceFor(date);
          const r = calcTotal(kwh, ep, snap);
          importPreview.push({
            id: Date.now().toString(36) + Math.random().toString(36).substr(2,5) + i,
            date, time: time || null, snap, kwh, energyPrice: ep,
            total: Math.round(r.total*100)/100, bruttoPerKwh: r.bruttoPerKwh,
            source: 'go-e', maxKw, dauer, dauerGesamt,
            created: new Date().toISOString(),
          });
        }
      } else {
        const hasHeader = header.includes('date') || header.includes('datum');
        const start = hasHeader ? 1 : 0;
        for(let i = start; i < lines.length; i++) {
          const parts = lines[i].split(/[,;\t]/);
          if(parts.length < 2) continue;
          let date = parts[0].trim();
          let kwh = parseFloat(parts[1].trim().replace(',','.'));
          // priceManual am geparsten Wert festmachen, nicht an der Existenz der
          // Spalte: Müll in Spalte 3 hätte den Eintrag sonst als „manuell"
          // markiert und dauerhaft von migrateTariffPrices() ausgenommen.
          const epRaw = parts[2] !== undefined ? parseFloat(parts[2].trim().replace(',','.')) : NaN;
          const epManual = isFinite(epRaw) && epRaw >= 0;
          if(!date || isNaN(kwh) || kwh <= 0) continue;
          if(date.includes('.')) {
            const dp = date.split('.');
            if(dp.length === 3) date = `${dp[2]}-${dp[1].padStart(2,'0')}-${dp[0].padStart(2,'0')}`;
          }
          const ep = epManual ? epRaw : energyPriceFor(date);
          const exists = charges.some(c => c.date === date && Math.abs(c.kwh - kwh) < 0.01);
          if(exists) continue;
          const r = calcTotal(kwh, ep);
          importPreview.push({
            id: Date.now().toString(36) + Math.random().toString(36).substr(2,4),
            date, kwh, energyPrice: ep, priceManual: epManual,
            total: Math.round(r.total*100)/100, bruttoPerKwh: r.bruttoPerKwh,
            created: new Date().toISOString(),
          });
        }
      }
    }

    // Show preview instead of immediately saving
    showImportPreview();
  };
  reader.readAsText(file);
}

function showImportPreview() {
  const area = document.getElementById('import-result');
  if(importPreview.length === 0 && importBackfill.length === 0) {
    area.innerHTML = `<div class="import-preview"><div style="text-align:center;color:var(--text-secondary);padding:12px;">Keine neuen Einträge gefunden (evtl. bereits importiert).</div></div>`;
    return;
  }

  const totalKwh = importPreview.reduce((s,c) => s + c.kwh, 0);
  const totalEur = importPreview.reduce((s,c) => s + c.total, 0);
  const show = importPreview.slice(0, 5);
  const more = importPreview.length - show.length;
  const bfShow = importBackfill.slice(0, 5);
  const bfMore = importBackfill.length - bfShow.length;
  const fieldLabel = { maxKw: 'max. Leistung', dauerGesamt: 'Steckdauer', dauer: 'Ladezeit' };

  area.innerHTML = `
    <div class="import-preview">
      <div class="ip-header">
        <span class="ip-title">Vorschau</span>
        <span class="ip-count">${importPreview.length} neu${importBackfill.length ? ` • ${importBackfill.length} ergänzt` : ''}</span>
      </div>
      ${show.map(c => `
        <div class="ip-entry">
          <span class="ip-date">${fmtDate(c.date)}</span>
          <span class="ip-kwh">${fmt(c.kwh,1)} kWh</span>
        </div>
      `).join('')}
      ${more > 0 ? `<div class="ip-more">+ ${more} weitere Einträge</div>` : ''}
      ${importBackfill.length ? `
        <div class="ip-header" style="margin-top:10px;">
          <span class="ip-title">Bestehende Ladungen ergänzen</span>
        </div>
        ${bfShow.map(b => `
          <div class="ip-entry">
            <span class="ip-date">${fmtDate(b.date)}</span>
            <span class="ip-kwh">${Object.entries(b.patch).map(([k,v]) =>
              `${fieldLabel[k] || k}: ${k === 'maxKw' ? fmt(v,2) + ' kW' : v}`).join(' • ')}</span>
          </div>
        `).join('')}
        ${bfMore > 0 ? `<div class="ip-more">+ ${bfMore} weitere Ergänzungen</div>` : ''}
      ` : ''}
      <div class="ip-summary">
        <div><div class="ip-stat-val">${fmt(totalKwh,1)}</div><div class="ip-stat-label">kWh</div></div>
        <div><div class="ip-stat-val">${fmt(totalEur)}</div><div class="ip-stat-label">Euro</div></div>
        <div><div class="ip-stat-val">${importPreview.length}</div><div class="ip-stat-label">Ladungen</div></div>
      </div>
      <div class="ip-buttons">
        <button class="ip-btn-cancel" onclick="cancelImport()">Abbrechen</button>
        <button class="ip-btn-import" onclick="confirmImport()">Importieren</button>
      </div>
    </div>
  `;
}

function confirmImport() {
  const count = importPreview.length;
  const totalKwh = importPreview.reduce((s,c) => s + c.kwh, 0);
  const totalEur = importPreview.reduce((s,c) => s + c.total, 0);

  // Ergänzungen an bestehenden Einträgen: nur die Felder aus patch, nichts sonst.
  let patched = 0;
  importBackfill.forEach(b => {
    const c = charges.find(x => x.id === b.id);
    if(c) { Object.assign(c, b.patch); patched++; }
  });

  charges.push(...importPreview);
  charges.sort((a,b) => b.date.localeCompare(a.date));
  persist();

  importPreview = [];
  importBackfill = [];
  document.getElementById('import-result').innerHTML = '';
  const parts = [];
  if(count) parts.push(`+${count} Ladungen • ${fmt(totalKwh,1)} kWh • ${fmt(totalEur)} €`);
  if(patched) parts.push(`${patched} ergänzt`);
  showToast(parts.join(' • ') || 'Nichts zu importieren');
}

function cancelImport() {
  importPreview = [];
  importBackfill = [];
  document.getElementById('import-result').innerHTML = '';
  showToast('Import abgebrochen');
}

function exportData() {
  const json = JSON.stringify(charges, null, 2);
  const blob = new Blob([json], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ladefuchs-export-${localDateStr()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('Export heruntergeladen');
}

// =====================================================================
// SETTINGS
// =====================================================================
function toggleSettings() {
  const m = document.getElementById('settings-modal');
  if(m.classList.contains('show')) {
    m.classList.remove('show');
  } else {
    document.getElementById('set-energy').value = settings.defaultEnergy;
    document.getElementById('set-gab').value = settings.gebrauchsabgabe;
    document.getElementById('set-ust').value = settings.ust;
    document.getElementById('set-tesla-kwh').value = settings.comp_tesla_kwh;
    document.getElementById('set-tesla-abo').value = settings.comp_tesla_abo_jahr;
    document.getElementById('set-tanke-kwh').value = settings.comp_tanke_kwh;
    document.getElementById('set-tanke-min').value = settings.comp_tanke_zeit_min;
    document.getElementById('set-tanke-abo').value = settings.comp_tanke_zeit_abo_monat;
    document.getElementById('set-benzin-l').value = settings.comp_benzin_verbrauch_l;
    document.getElementById('set-benzin-l-max').value = settings.comp_benzin_verbrauch_l_max;
    document.getElementById('set-ev-kwh').value = settings.comp_ev_verbrauch_kwh;
    document.getElementById('set-benzin-preis').value = settings.comp_benzin_preis;
    document.getElementById('set-wallbox-installation').value = settings.comp_wallbox_installation;
    document.getElementById('set-goe-serial').value = settings.goe_serial || '';
    document.getElementById('set-goe-token').value = settings.goe_token || '';
    renderTariffHistory(settings.tariffHistory || []);
    m.classList.add('show');
  }
}

function saveSettings() {
  settings.defaultEnergy = parseFloat(document.getElementById('set-energy').value) || 0.12;
  settings.gebrauchsabgabe = parseFloat(document.getElementById('set-gab').value) || 7;
  settings.ust = parseFloat(document.getElementById('set-ust').value) || 20;
  settings.comp_tesla_kwh = parseFloat(document.getElementById('set-tesla-kwh').value) || 0.48;
  settings.comp_tesla_abo_jahr = parseFloat(document.getElementById('set-tesla-abo').value) || 99;
  settings.comp_tanke_kwh = parseFloat(document.getElementById('set-tanke-kwh').value) || 0.39;
  settings.comp_tanke_zeit_min = parseFloat(document.getElementById('set-tanke-min').value) || 0.069;
  settings.comp_tanke_zeit_abo_monat = parseFloat(document.getElementById('set-tanke-abo').value) || 4.90;
  settings.comp_benzin_verbrauch_l = parseFloat(document.getElementById('set-benzin-l').value) || 8.2;
  settings.comp_benzin_verbrauch_l_max = parseFloat(document.getElementById('set-benzin-l-max').value) || 9.5;
  settings.comp_ev_verbrauch_kwh = parseFloat(document.getElementById('set-ev-kwh').value) || 20.0;
  settings.comp_benzin_preis = parseFloat(document.getElementById('set-benzin-preis').value) || 1.80;
  settings.comp_wallbox_installation = parseFloat(document.getElementById('set-wallbox-installation').value) || 2685.40;
  settings.goe_serial = document.getElementById('set-goe-serial').value.trim();
  settings.goe_token = document.getElementById('set-goe-token').value.trim();
  settings.tariffHistory = readTariffRows()
    .filter(p => typeof p.energy === 'number' && !isNaN(p.energy))
    .sort((a, b) => (a.from || '0000-01-01').localeCompare(b.from || '0000-01-01'));
  applyTheme();
  persist();
  toggleSettings();
  initAddPage();
  startLiveStatus();
  // Energiepreise bestehender Ladungen ggf. an die geänderte Historie angleichen
  Promise.resolve(migrateTariffPrices()).then(() => refreshDashboard());
  showToast('Einstellungen gespeichert');
}

// =====================================================================
// TARIF-HISTORIE EDITOR (Einstellungen)
// =====================================================================
function tariffRowHTML(p) {
  const energy = (p.energy != null && !isNaN(p.energy)) ? p.energy : '';
  return `<div class="tariff-row">
    <input type="text" class="th-label" placeholder="Anbieter / Tarif" value="${(p.label || '').replace(/"/g, '&quot;')}"/>
    <input type="date" class="th-from" value="${p.from || ''}" title="gültig ab (leer = ab Beginn)"/>
    <input type="number" class="th-energy" step="0.0001" inputmode="decimal" placeholder="€/kWh netto" value="${energy}"/>
    <button type="button" class="th-del" title="Entfernen" onclick="removeTariffRow(this)">✕</button>
  </div>`;
}

function readTariffRows() {
  return [...document.querySelectorAll('#tariff-history-list .tariff-row')].map(row => ({
    label: row.querySelector('.th-label').value.trim(),
    from: row.querySelector('.th-from').value,
    energy: parseFloat(row.querySelector('.th-energy').value),
  }));
}

function renderTariffHistory(periods) {
  const list = document.getElementById('tariff-history-list');
  if(!list) return;
  list.innerHTML = (periods && periods.length)
    ? periods.map(tariffRowHTML).join('')
    : '<div class="tariff-empty">Keine Perioden – der Standard-Energiepreis gilt für alle Ladungen.</div>';
}

function addTariffRow() {
  const periods = readTariffRows();
  periods.push({ label: '', from: '', energy: '' });
  renderTariffHistory(periods);
}

function removeTariffRow(btn) {
  btn.closest('.tariff-row').remove();
  if(!document.querySelector('#tariff-history-list .tariff-row')) renderTariffHistory([]);
}

// =====================================================================
// TOAST
// =====================================================================
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

// =====================================================================
// SAVINGS COMPARISON
// =====================================================================
function renderSavings() {
  const area = document.getElementById('savings-area');
  if (!area) return;

  const shell = body => { area.innerHTML = sectionShell('savings', 'Ersparnis vs. Alternativen', body); };

  if (charges.length === 0) {
    shell('<div class="empty-state" style="padding:16px;">Noch keine Ladevorgänge erfasst.</div>');
    return;
  }

  const now = new Date();
  let filtered = charges;
  if (currentPeriod === 'month') {
    const m = now.getMonth(), y = now.getFullYear();
    filtered = charges.filter(c => { const d=new Date(c.date); return d.getMonth()===m && d.getFullYear()===y; });
  } else if (currentPeriod === 'year') {
    const y = now.getFullYear();
    filtered = charges.filter(c => new Date(c.date).getFullYear()===y);
  }

  if (filtered.length === 0) {
    shell('<div style="color:var(--text-muted);font-size:14px;padding:8px 0;">Keine Daten im gewählten Zeitraum.</div>');
    return;
  }

  const totalKwh = filtered.reduce((s, c) => s + c.kwh, 0);
  const totalCost = filtered.reduce((s, c) => s + c.total, 0);

  function parseDauerMinutes(dauer) {
    if (!dauer) return null;
    const parts = dauer.split(':').map(Number);
    if (parts.length === 3) return parts[0] * 60 + parts[1] + parts[2] / 60;
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return null;
  }

  const totalMinutes = filtered.reduce((s, c) => s + (parseDauerMinutes(c.dauer) || 0), 0);
  const hasZeit = totalMinutes > 0;

  const s = settings;
  const costTesla = totalKwh * s.comp_tesla_kwh;
  const costTankeKwh = totalKwh * s.comp_tanke_kwh;
  const costTankeZeit = hasZeit ? totalMinutes * s.comp_tanke_zeit_min : null;

  const savingTesla = costTesla - totalCost;
  const savingTankeKwh = costTankeKwh - totalCost;
  const savingTankeZeit = costTankeZeit !== null ? costTankeZeit - totalCost : null;

  let aboTesla, aboTankeZeit;
  if (currentPeriod === 'month') {
    aboTesla = s.comp_tesla_abo_jahr / 12;
    aboTankeZeit = s.comp_tanke_zeit_abo_monat;
  } else if (currentPeriod === 'year') {
    aboTesla = s.comp_tesla_abo_jahr;
    aboTankeZeit = s.comp_tanke_zeit_abo_monat * 12;
  } else {
    const dates = filtered.map(c => new Date(c.date));
    const minDate = new Date(Math.min(...dates));
    const maxDate = new Date(Math.max(...dates));
    const months = Math.max(1, (maxDate - minDate) / (1000 * 60 * 60 * 24 * 30.5));
    aboTesla = (s.comp_tesla_abo_jahr / 12) * months;
    aboTankeZeit = s.comp_tanke_zeit_abo_monat * months;
  }

  function savingCard(label, icon, altCost, saving, hint = null) {
    const positive = saving > 0;
    const color = positive ? 'var(--green)' : '#ef4444';
    const arrow = positive ? '↓' : '↑';
    return `
      <div class="savings-card">
        <div class="sc-header">
          <span class="sc-icon">${icon}</span>
          <span class="sc-label">${label}</span>
        </div>
        <div class="sc-row">
          <span class="sc-key">Kosten dort</span>
          <span class="sc-val">${fmt(altCost)} €</span>
        </div>
        <div class="sc-row">
          <span class="sc-key">Kosten Wallbox</span>
          <span class="sc-val">${fmt(totalCost)} €</span>
        </div>
        <div class="sc-divider"></div>
        <div class="sc-row sc-saving" style="color:${color}">
          <span>${positive ? '✓ Du sparst' : '✗ Du zahlst mehr'}</span>
          <span>${arrow} ${fmt(Math.abs(saving))} €</span>
        </div>
        ${hint ? `<div class="sc-hint">${hint}</div>` : ''}
      </div>
    `;
  }

  let html = `<div class="savings-grid">`;
  html += savingCard('Tesla Supercharger', '⚡', costTesla, savingTesla);
  html += savingCard('Tanke Wien kWh', '🔵', costTankeKwh, savingTankeKwh);
  if (hasZeit && costTankeZeit !== null) {
    html += savingCard('Tanke Wien Zeit', '🕐', costTankeZeit, savingTankeZeit,
      'Tanke Wien rechnet nach Steckdauer – go-e API liefert nur aktive Ladezeit, daher Schätzung');
  } else {
    html += `<div class="savings-card sc-disabled">
      <div class="sc-header"><span class="sc-icon">🕐</span><span class="sc-label">Tanke Wien Zeit</span></div>
      <div style="font-size:13px;color:var(--text-muted);padding:8px 0;">Ladezeit nicht verfügbar<br>(go-e CSV mit "Dauer aktiver Stromfluss" importieren)</div>
    </div>`;
  }
  // Benzin-Vergleich
  const kmEV = totalKwh / (s.comp_ev_verbrauch_kwh / 100);
  const costBenzin = kmEV * (s.comp_benzin_verbrauch_l / 100) * benzinPreis();
  const savingBenzin = costBenzin - totalCost;
  html += `
    <div class="savings-card">
      <div class="sc-header">
        <span class="sc-icon">⛽</span>
        <span class="sc-label">Tiguan (Benzin)</span>
      </div>
      <div class="sc-row">
        <span class="sc-key">Gefahrene km (geschätzt)</span>
        <span class="sc-val">${fmt(kmEV, 0)} km</span>
      </div>
      <div class="sc-row">
        <span class="sc-key">Benzinkosten (${fmt(s.comp_benzin_verbrauch_l, 1)}L/100km)</span>
        <span class="sc-val">${fmt(costBenzin)} €</span>
      </div>
      <div class="sc-row">
        <span class="sc-key">Kosten Wallbox</span>
        <span class="sc-val">${fmt(totalCost)} €</span>
      </div>
      <div class="sc-divider"></div>
      <div class="sc-row sc-saving" style="color:${savingBenzin > 0 ? 'var(--green)' : '#ef4444'}">
        <span>${savingBenzin > 0 ? '✓ Du sparst' : '✗ Du zahlst mehr'}</span>
        <span>${savingBenzin > 0 ? '↓' : '↑'} ${fmt(Math.abs(savingBenzin))} €</span>
      </div>
      <div class="sc-abo" id="benzin-preis-badge">
        ${benzinPreisLabel()}
      </div>
    </div>
  `;

  html += `</div>`;
  shell(html);
}

// =====================================================================
// AMORTISATION
// =====================================================================
function renderAmortisation() {
  const area = document.getElementById('amortisation-area');
  if (!area) return;

  if (currentPeriod !== 'all' || charges.length === 0) {
    area.innerHTML = '';
    return;
  }

  const installation = settings.comp_wallbox_installation;
  const s = settings;

  const totalCostAll = charges.reduce((s, c) => s + c.total, 0);

  const savingTeslaAll = charges.reduce((sum, c) => sum + (c.kwh * s.comp_tesla_kwh) - c.total, 0);
  const savingTankeAll = charges.reduce((sum, c) => sum + (c.kwh * s.comp_tanke_kwh) - c.total, 0);
  const savingBenzinAll = charges.reduce((sum, c) => {
    const km = c.kwh / (s.comp_ev_verbrauch_kwh / 100);
    const benzinCost = km * (s.comp_benzin_verbrauch_l / 100) * benzinPreis();
    return sum + benzinCost - c.total;
  }, 0);

  const firstDate = new Date(charges[charges.length - 1].date);
  const monthsElapsed = Math.max(1, (new Date() - firstDate) / (1000 * 60 * 60 * 24 * 30.5));

  function amortCard(label, icon, saving) {
    const pct = Math.min(100, (saving / installation) * 100);
    const remaining = Math.max(0, installation - saving);
    const monthlyAvg = saving / monthsElapsed;
    const monthsLeft = monthlyAvg > 0 ? remaining / monthlyAvg : Infinity;
    const breakEvenDate = new Date();
    breakEvenDate.setMonth(breakEvenDate.getMonth() + Math.ceil(monthsLeft));
    const breakEvenStr = isFinite(monthsLeft)
      ? breakEvenDate.toLocaleDateString('de-AT', { month: 'long', year: 'numeric' })
      : '–';

    const footer = pct >= 100
      ? `<div style="color:var(--green);font-weight:600;text-align:center;padding:4px 0;">✅ Amortisiert!</div>`
      : `<div class="sc-row"><span>Break-even ca.</span><span style="font-weight:600;">${breakEvenStr}</span></div>`;

    return `
      <div class="savings-card">
        <div class="sc-header"><span class="sc-icon">${icon}</span><span class="sc-label">${label}</span></div>
        <div class="sc-row"><span class="sc-key">Installationskosten</span><span class="sc-val">${fmt(installation)} €</span></div>
        <div class="sc-row"><span class="sc-key">Gespart bisher</span><span class="sc-val" style="color:var(--green)">${fmt(saving)} €</span></div>
        <div class="sc-row"><span class="sc-key">Noch zu sparen</span><span class="sc-val">${fmt(remaining)} €</span></div>
        <div class="amort-bar-wrap"><div class="amort-bar-fill" style="width:${pct}%"></div></div>
        <div style="font-size:11px;color:var(--text-muted);text-align:right;">${fmt(pct, 1)}%</div>
        <div class="sc-divider"></div>
        ${footer}
      </div>`;
  }

  area.innerHTML = sectionShell('amortisation', '🏠 Amortisation Wallbox', `
    <div class="savings-grid">
      ${amortCard('Tesla Supercharger', '⚡', savingTeslaAll)}
      ${amortCard('Tanke Wien kWh', '🔵', savingTankeAll)}
      ${amortCard('Benzin (Tiguan)', '⛽', savingBenzinAll)}
    </div>`);
}

// =====================================================================
// DETAIL PAGE
// =====================================================================
function showDetail(id) {
  const c = charges.find(ch => ch.id === id);
  if (!c) return;

  function fmtDauer(dauer) {
    if (!dauer) return null;
    const parts = dauer.split(':').map(Number);
    if (parts.length !== 3) return dauer;
    const h = parts[0], m = parts[1];
    if (h > 0 && m > 0) return `${h}h ${String(m).padStart(2, '0')}min`;
    if (h > 0) return `${h}h`;
    return `${m}min`;
  }

  function parseDauerMinutes(dauer) {
    if (!dauer) return null;
    const parts = dauer.split(':').map(Number);
    if (parts.length === 3) return parts[0] * 60 + parts[1] + parts[2] / 60;
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return null;
  }

  const ep = c.energyPrice || energyPriceFor(c.date);
  const snap = c.snap || false;
  const r = calcTotal(c.kwh, ep, snap);
  const bd = r.breakdown;

  const minutes = parseDauerMinutes(c.dauer);
  const hasZeit = minutes !== null && minutes > 0;
  const dauerFormatted = fmtDauer(c.dauer);

  const s = settings;
  const myCost = c.total;
  const costTesla = c.kwh * s.comp_tesla_kwh;
  const costTankeKwh = c.kwh * s.comp_tanke_kwh;
  const costTankeZeit = hasZeit ? minutes * s.comp_tanke_zeit_min : null;
  const kmEV = c.kwh / (s.comp_ev_verbrauch_kwh / 100);
  const costBenzin = kmEV * (s.comp_benzin_verbrauch_l / 100) * benzinPreis();

  function scCard(label, icon, altCost, saving, hint = null) {
    const positive = saving > 0;
    const color = positive ? 'var(--green)' : '#ef4444';
    const arrow = positive ? '↓' : '↑';
    return `
      <div class="savings-card">
        <div class="sc-header"><span class="sc-icon">${icon}</span><span class="sc-label">${label}</span></div>
        <div class="sc-row"><span class="sc-key">Kosten dort</span><span class="sc-val">${fmt(altCost)} €</span></div>
        <div class="sc-row"><span class="sc-key">Kosten Wallbox</span><span class="sc-val">${fmt(myCost)} €</span></div>
        <div class="sc-divider"></div>
        <div class="sc-row sc-saving" style="color:${color}">
          <span>${positive ? '✓ Du sparst' : '✗ Du zahlst mehr'}</span>
          <span>${arrow} ${fmt(Math.abs(saving))} €</span>
        </div>
        ${hint ? `<div class="sc-hint">${hint}</div>` : ''}
      </div>`;
  }

  const savingBenzin = costBenzin - myCost;
  let savingsHtml = `<div class="savings-grid">`;
  savingsHtml += scCard('Tesla Supercharger', '⚡', costTesla, costTesla - myCost);
  savingsHtml += scCard('Tanke Wien kWh', '🔵', costTankeKwh, costTankeKwh - myCost);
  if (hasZeit) {
    savingsHtml += scCard('Tanke Wien Zeit', '🕐', costTankeZeit, costTankeZeit - myCost,
      'Tanke Wien rechnet nach Steckdauer – go-e API liefert nur aktive Ladezeit, daher Schätzung');
  } else {
    savingsHtml += `<div class="savings-card sc-disabled">
      <div class="sc-header"><span class="sc-icon">🕐</span><span class="sc-label">Tanke Wien Zeit</span></div>
      <div style="font-size:13px;color:var(--text-muted);padding:8px 0;">Ladezeit nicht verfügbar</div>
    </div>`;
  }
  savingsHtml += `
    <div class="savings-card">
      <div class="sc-header"><span class="sc-icon">⛽</span><span class="sc-label">Tiguan (Benzin)</span></div>
      <div class="sc-row"><span class="sc-key">Gefahrene km (geschätzt)</span><span class="sc-val">${fmt(kmEV, 0)} km</span></div>
      <div class="sc-row"><span class="sc-key">Benzinkosten (${fmt(s.comp_benzin_verbrauch_l, 1)}L/100km)</span><span class="sc-val">${fmt(costBenzin)} €</span></div>
      <div class="sc-row"><span class="sc-key">Kosten Wallbox</span><span class="sc-val">${fmt(myCost)} €</span></div>
      <div class="sc-divider"></div>
      <div class="sc-row sc-saving" style="color:${savingBenzin > 0 ? 'var(--green)' : '#ef4444'}">
        <span>${savingBenzin > 0 ? '✓ Du sparst' : '✗ Du zahlst mehr'}</span>
        <span>${savingBenzin > 0 ? '↓' : '↑'} ${fmt(Math.abs(savingBenzin))} €</span>
      </div>
      <div class="sc-abo">${benzinPreisLabel()}</div>
    </div>`;
  savingsHtml += `</div>`;

  const snapBadge = snap
    ? `<span class="detail-snap-badge">☀️ SNAP –20%</span>`
    : `<div class="rc-dot"></div>`;

  document.getElementById('page-detail').innerHTML = `
    <div class="detail-header">
      <button class="detail-back" onclick="showPage('dashboard')" aria-label="Zurück">
        <span class="material-symbols-outlined">arrow_back</span>
      </button>
      <div class="detail-title">Ladevorgang</div>
      <button class="detail-back" onclick="openEdit('${c.id}')" aria-label="Bearbeiten" style="margin-left:auto;">
        <span class="material-symbols-outlined">edit</span>
      </button>
    </div>

    <div class="section-title" style="margin-top:8px;">Übersicht</div>
    <div class="result-card" style="margin-top:0;">
      <div class="rc-header">
        <span class="rc-label">Gesamtkosten</span>
        ${snapBadge}
      </div>
      <div class="rc-amount"><span>${fmt(c.total)}</span><span class="curr"> €</span></div>
      <div class="rc-breakdown">
        <div class="rb-row"><span>Datum &amp; Uhrzeit</span><span class="rb-val">${fmtDate(c.date)}${c.time ? ', ' + c.time + ' Uhr' : ''}</span></div>
        <div class="rb-row"><span>Energie geladen</span><span class="rb-val">${fmt(c.kwh, 3)} kWh</span></div>
        ${dauerFormatted ? `<div class="rb-row"><span>Aktive Ladezeit</span><span class="rb-val">${dauerFormatted}</span></div>` : ''}
        ${c.maxKw ? `<div class="rb-row"><span>Max. Leistung</span><span class="rb-val">${fmt(c.maxKw, 2)} kW</span></div>` : ''}
        <div class="rb-row"><span>Quelle</span><span class="rb-val" style="color:var(--text-muted);font-size:11px;">${c.source || 'manuell'}</span></div>
      </div>
    </div>

    <div class="section-title">Kostenaufschlüsselung</div>
    <div class="result-card" style="margin-top:0;">
      <div class="rc-breakdown">
        <div class="rb-row"><span>Energie (${fmt(ep, 4)} €/kWh)</span><span class="rb-val">${fmt(bd.energy)} €</span></div>
        <div class="rb-row"><span>Netznutzung (${fmt(r.netznutzung * 100, 2)} ct${snap ? ' ☀️ –20%' : ''})</span><span class="rb-val">${fmt(bd.netznutzung)} €</span></div>
        <div class="rb-row"><span>Netzverlust (0,70 ct)</span><span class="rb-val">${fmt(bd.netzverlust, 3)} €</span></div>
        <div class="rb-row"><span>GAB ${settings.gebrauchsabgabe}% auf Energie+Netz</span><span class="rb-val">${fmt(bd.gabBetrag, 3)} €</span></div>
        <div class="rb-row"><span>Förderbeitrag</span><span class="rb-val">${fmt(bd.foerderbeitrag, 3)} €</span></div>
        <div class="rb-row"><span>Elektrizitätsabgabe</span><span class="rb-val">${fmt(bd.eAbgabe, 3)} €</span></div>
        <div class="rb-row" style="font-weight:500;color:var(--text);"><span>Netto gesamt</span><span class="rb-val">${fmt(bd.nettoGesamt)} €</span></div>
        <div class="rb-row"><span>USt (${settings.ust}%)</span><span class="rb-val">${fmt(bd.ust)} €</span></div>
        <div class="rb-row rb-total"><span>Brutto gesamt</span><span class="rb-val">${fmt(bd.bruttoGesamt)} €</span></div>
      </div>
    </div>

    <div class="section-title">Ersparnis vs. Alternativen</div>
    ${savingsHtml}
  `;

  showPage('detail');
}

// =====================================================================
// EDIT CHARGE
// =====================================================================
let editingId = null;

function openEdit(id) {
  const c = charges.find(ch => ch.id === id);
  if (!c) return;
  editingId = id;
  document.getElementById('edit-kwh').value = c.kwh;
  document.getElementById('edit-energy').value = c.energyPrice || energyPriceFor(c.date);
  document.getElementById('edit-date').value = c.date;
  document.getElementById('edit-time').value = c.time || '';
  document.getElementById('edit-modal').classList.add('show');
}

function closeEdit() {
  editingId = null;
  document.getElementById('edit-modal').classList.remove('show');
}

function saveEdit() {
  if (!editingId) return;
  const kwh = parseFloat(document.getElementById('edit-kwh').value);
  const energy = parseFloat(document.getElementById('edit-energy').value);
  const date = document.getElementById('edit-date').value;
  const time = document.getElementById('edit-time').value;
  if (!kwh || kwh <= 0 || !date) return;

  const idx = charges.findIndex(ch => ch.id === editingId);
  if (idx === -1) return;
  const existing = charges[idx];
  // go-e-auto speichert das Ladeende als time → Mittelpunkt rückwärts; sonst
  // (CSV-Import / manuelle Eingabe) gilt die Zeit als Ladebeginn → vorwärts.
  const anchor = existing.source === 'go-e-auto' ? 'end' : 'start';
  const snap = isSnap(date, time, dauerToMs(existing.dauer), anchor);
  const r = calcTotal(kwh, energy, snap);

  charges[idx] = {
    ...charges[idx],
    kwh,
    energyPrice: energy,
    // Weicht der Preis von der Tarif-Historie ab, gilt er als manuell → bleibt bei der Migration unangetastet
    priceManual: Math.abs(energy - energyPriceFor(date)) > 1e-9,
    date,
    time: time || null,
    snap,
    total: Math.round(r.total * 100) / 100,
    bruttoPerKwh: r.bruttoPerKwh,
  };
  charges.sort((a, b) => b.date.localeCompare(a.date));
  persist();
  closeEdit();
  showToast('Ladevorgang aktualisiert');
  refreshDashboard();
}

// =====================================================================
// MONTHLY STATS
// =====================================================================
// Aufgeklappte Monate im Monatsverlauf ('YYYY-MM'). Modul-Variable, damit der
// Zustand ein Neu-Rendern (persist/render) überlebt.
let expandedMonths = new Set();

function toggleMonthDetail(key) {
  if (expandedMonths.has(key)) expandedMonths.delete(key);
  else expandedMonths.add(key);
  renderMonthStats();
}

function renderMonthStats() {
  const area = document.getElementById('month-stats-area');
  if (!area) return;

  if (currentPeriod === 'month') { area.innerHTML = ''; return; }

  const data = currentPeriod === 'all'
    ? charges
    : charges.filter(c => new Date(c.date).getFullYear() === new Date().getFullYear());

  if (data.length === 0) { area.innerHTML = ''; return; }

  const byMonth = {};
  data.forEach(c => {
    const key = c.date.slice(0, 7);
    if (!byMonth[key]) byMonth[key] = { count: 0, kwh: 0, cost: 0, snapCount: 0, items: [] };
    byMonth[key].count++;
    byMonth[key].kwh += c.kwh;
    byMonth[key].cost += c.total;
    if (c.snap) byMonth[key].snapCount++;
    byMonth[key].items.push(c);
  });

  const rows = Object.keys(byMonth).sort().reverse().map(key => {
    const m = byMonth[key];
    const avgCt = m.kwh > 0 ? (m.cost / m.kwh) * 100 : 0;
    const [y, mo] = key.split('-');
    const label = new Date(parseInt(y), parseInt(mo) - 1, 1)
      .toLocaleDateString('de-AT', { month: 'long', year: 'numeric' });
    const open = expandedMonths.has(key);

    // Höchste Ladeleistung des Monats – ab 2027 die Grösse, die den
    // Leistungspreis bestimmt. Nur zeigen, wenn überhaupt Werte da sind.
    const peak = m.items.reduce((mx, c) => (c.maxKw > 0 && c.maxKw > mx ? c.maxKw : mx), 0);

    const detail = !open ? '' : `
      <div class="month-detail">
        ${m.items.slice().sort((a, b) =>
            (b.date + (b.time || '')).localeCompare(a.date + (a.time || ''))).map(c => `
          <div class="md-row">
            <span class="md-date">${fmtDateShort(c.date)}${c.time ? ' · ' + c.time : ''}${c.snap ? ' ☀️' : ''}</span>
            <span class="md-kwh">${fmt(c.kwh, 1)} kWh</span>
            <span class="md-peak">${c.maxKw > 0 ? fmt(c.maxKw, 2) + ' kW' : '—'}</span>
            <span class="md-cost">${fmt(c.total)} €</span>
          </div>
        `).join('')}
        ${peak > 0 ? `<div class="md-foot">Höchste Ladeleistung im Monat: <strong>${fmt(peak, 2)} kW</strong></div>` : ''}
      </div>`;

    return `
      <div class="month-stat-block${open ? ' is-open' : ''}">
        <div class="month-stat-row" role="button" tabindex="0" aria-expanded="${open}"
             onclick="toggleMonthDetail('${key}')"
             onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();toggleMonthDetail('${key}');}">
          <span class="msr-chevron">${open ? '▾' : '▸'}</span>
          <div class="msr-left">
            <div class="msr-month">${label}</div>
            <div class="msr-meta">${m.count} Ladung${m.count !== 1 ? 'en' : ''}${m.snapCount > 0 ? ' · ☀️ ' + m.snapCount : ''}</div>
          </div>
          <div class="msr-mid">${fmt(m.kwh, 1)}<span class="msr-unit"> kWh</span></div>
          <div class="msr-right">
            <div class="msr-cost">${fmt(m.cost)} €</div>
            <div class="msr-avg">${fmt(avgCt, 1)} ct/kWh</div>
          </div>
        </div>
        ${detail}
      </div>`;
  }).join('');

  area.innerHTML = sectionShell('monthstats', '📅 Monatsverlauf',
    `<div class="month-stats-card">${rows}</div>`);
}

// =====================================================================
// GO-E LIVE STATUS
// =====================================================================
let liveStatusInterval = null;
let liveStatusData = null;
let liveStatusError = null;

const GOE_CAR_STATES = {
  1: { label: 'Kein Auto verbunden', icon: 'ev_station', color: 'var(--text-muted)', cls: '' },
  2: { label: 'Lädt gerade', icon: 'bolt', color: 'var(--green)', cls: 'ls-charging' },
  3: { label: 'Verbunden – wartet', icon: 'cable', color: 'var(--primary)', cls: 'ls-waiting' },
  4: { label: 'Vollgeladen', icon: 'check_circle', color: 'var(--green)', cls: 'ls-done' },
};

async function fetchLiveStatus() {
  const serial = (settings.goe_serial || '').trim();
  const token = (settings.goe_token || '').trim();
  if (!serial || !token) return;

  try {
    const res = await fetch(`https://${serial}.api.v3.go-e.io/api/status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    liveStatusData = await res.json();
    liveStatusError = null;
  } catch (e) {
    liveStatusError = e.message;
    liveStatusData = null;
  }
  renderLiveStatus();
}

function renderLiveStatus() {
  const area = document.getElementById('live-status-area');
  if (!area) return;

  const serial = (settings.goe_serial || '').trim();
  const token = (settings.goe_token || '').trim();
  if (!serial || !token) { area.innerHTML = ''; return; }

  if (liveStatusError) {
    area.innerHTML = `
      <div class="live-status-card">
        <div class="ls-header">
          <span class="material-symbols-outlined ls-icon" style="color:var(--text-muted);">error_outline</span>
          <div>
            <div class="ls-label">go-e nicht erreichbar</div>
            <div class="ls-updated">${liveStatusError}</div>
          </div>
        </div>
      </div>`;
    return;
  }

  if (!liveStatusData) {
    area.innerHTML = `
      <div class="live-status-card">
        <div class="ls-header">
          <span class="material-symbols-outlined ls-icon ls-spin" style="color:var(--text-muted);">sync</span>
          <div class="ls-label">Verbinde mit go-e…</div>
        </div>
      </div>`;
    return;
  }

  const car = liveStatusData.car;
  const wh = liveStatusData.wh ?? 0;
  const kwh = Math.round((wh / 1000) * 100) / 100;
  const powerW = liveStatusData.nrg?.[11] ?? 0;
  const powerKw = Math.round((powerW / 1000) * 10) / 10;
  const state = GOE_CAR_STATES[car] || { label: `Unbekannt (${car})`, icon: 'help', color: 'var(--text-muted)', cls: '' };
  const now = new Date();
  const timeStr = now.toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' });

  let statsHtml = '';
  if (car === 2 && kwh > 0) {
    const snap = isSnap(localDateStr(now), now.toTimeString().slice(0, 5));
    const r = calcTotal(kwh, settings.defaultEnergy, snap);
    statsHtml = `
      <div class="ls-stats">
        <div class="ls-stat">
          <div class="ls-stat-val">${fmt(kwh, 2)}<span class="ls-stat-unit"> kWh</span></div>
          <div class="ls-stat-label">geladen</div>
        </div>
        <div class="ls-stat">
          <div class="ls-stat-val">${fmt(powerKw, 1)}<span class="ls-stat-unit"> kW</span></div>
          <div class="ls-stat-label">aktuell</div>
        </div>
        <div class="ls-stat">
          <div class="ls-stat-val">~${fmt(r.total, 2)}<span class="ls-stat-unit"> €</span></div>
          <div class="ls-stat-label">geschätzt</div>
        </div>
      </div>`;
  } else if ((car === 3 || car === 4) && kwh > 0) {
    const r = calcTotal(kwh, settings.defaultEnergy, false);
    statsHtml = `
      <div class="ls-stats">
        <div class="ls-stat">
          <div class="ls-stat-val">${fmt(kwh, 2)}<span class="ls-stat-unit"> kWh</span></div>
          <div class="ls-stat-label">geladen</div>
        </div>
        <div class="ls-stat">
          <div class="ls-stat-val">${fmt(r.total, 2)}<span class="ls-stat-unit"> €</span></div>
          <div class="ls-stat-label">Kosten</div>
        </div>
      </div>`;
  }

  area.innerHTML = `
    <div class="live-status-card ${state.cls}">
      <div class="ls-header">
        <span class="material-symbols-outlined ls-icon" style="color:${state.color};">${state.icon}</span>
        <div style="flex:1;">
          <div class="ls-label">${state.label}</div>
          <div class="ls-updated">Aktualisiert ${timeStr}</div>
        </div>
        ${car === 2 ? '<div class="ls-live-dot"></div>' : ''}
      </div>
      ${statsHtml}
    </div>`;
}

function startLiveStatus() {
  if (liveStatusInterval) { clearInterval(liveStatusInterval); liveStatusInterval = null; }
  const serial = (settings.goe_serial || '').trim();
  const token = (settings.goe_token || '').trim();
  if (!serial || !token) { renderLiveStatus(); return; }

  liveStatusData = null;
  liveStatusError = null;
  renderLiveStatus();
  fetchLiveStatus();
  liveStatusInterval = setInterval(() => {
    if (document.visibilityState !== 'hidden') fetchLiveStatus();
  }, 30000);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') fetchLiveStatus();
});

// =====================================================================
// INIT
// =====================================================================
initAddPage();
initImport();
refreshDashboard();
applyCollapsedState();   // statische Sektionen im HTML nachziehen
fetchBenzinpreis();
startLiveStatus();
