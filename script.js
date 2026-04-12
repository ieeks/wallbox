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
function isSnap(date, time) {
  if(!date || !time) return false;
  const month = new Date(date).getMonth(); // 0=Jan
  if(month < 3 || month > 8) return false; // Apr=3 … Sep=8
  const [h, m] = time.split(':').map(Number);
  const minutes = h * 60 + (m || 0);
  return minutes >= 10 * 60 && minutes < 16 * 60;
}

// =====================================================================
// STATE
// =====================================================================
let charges = JSON.parse(localStorage.getItem('lf_charges') || '[]');
let settings = JSON.parse(localStorage.getItem('lf_settings') || 'null') || {
  defaultEnergy: 0.140118,
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
};
settings = {
  comp_tesla_kwh: 0.48,
  comp_tesla_abo_jahr: 99.00,
  comp_tanke_kwh: 0.39,
  comp_tanke_zeit_min: 0.069,
  comp_tanke_zeit_abo_monat: 4.90,
  comp_benzin_verbrauch_l: 8.2,
  comp_ev_verbrauch_kwh: 20.0,
  comp_benzin_preis: 1.80,
  comp_wallbox_installation: 2685.40,
  ...settings,
};
let currentPeriod = 'month';

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
async function fetchBenzinpreis() {
  try {
    const url = 'https://api.e-control.at/sprit/1.0/search/gas-stations/by-address' +
      '?latitude=48.2082&longitude=16.3738&fuelType=SUP&includeClosed=false';
    const res = await fetch(url);
    if (!res.ok) return;
    const stations = await res.json();

    const prices = [];
    stations.forEach(s => {
      if (s.prices) {
        s.prices.forEach(p => {
          if (p.fuelType === 'SUP' && p.amount > 0) prices.push(p.amount);
        });
      }
    });

    if (prices.length === 0) return;

    prices.sort((a, b) => a - b);
    const mid = Math.floor(prices.length / 2);
    const median = prices.length % 2 !== 0
      ? prices[mid]
      : (prices[mid - 1] + prices[mid]) / 2;

    settings.comp_benzin_preis = Math.round(median * 1000) / 1000;

    const badge = document.getElementById('benzin-preis-badge');
    if (badge) badge.textContent = 'ℹ️ Benzinpreis: ' + fmt(settings.comp_benzin_preis, 3) + ' €/L (E-Control Wien)';

    renderSavings();
  } catch (e) {
    console.log('E-Control API nicht erreichbar, Fallback auf gespeicherten Preis');
  }
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

async function loadFromCloud() {
  if(!firebaseReady) return;
  setSyncStatus('syncing');
  try {
    const doc = await db.collection('haushalte').doc(HOUSEHOLD_DOC).get();
    if(doc.exists) {
      const data = doc.data();
      if(data.charges && data.charges.length > 0) {
        const cloudIds = new Set(data.charges.map(c => c.id));
        const localOnlyEntries = charges.filter(c => !cloudIds.has(c.id));
        charges = [...data.charges, ...localOnlyEntries];
        charges.sort((a,b) => b.date.localeCompare(a.date));
        // Push merged data back if we had local-only entries
        if(localOnlyEntries.length > 0) {
          localStorage.setItem('lf_charges', JSON.stringify(charges));
          localStorage.setItem('lf_settings', JSON.stringify(settings));
          await syncToCloud();
          return;
        }
      }
      if(data.settings) {
        settings = {...settings, ...data.settings};
      }
      localStorage.setItem('lf_charges', JSON.stringify(charges));
      localStorage.setItem('lf_settings', JSON.stringify(settings));
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

async function clearAllData() {
  if(firebaseReady) {
    try {
      await db.collection('haushalte').doc(HOUSEHOLD_DOC).delete();
    } catch(e) { console.error(e); }
  }
  localStorage.clear();
  location.reload();
}

// Beim Start: Daten aus Cloud laden
if(firebaseReady) {
  loadFromCloud().then(() => {
    applyTheme();
    initAddPage();
    refreshDashboard();
  });
} else {
  setSyncStatus('offline');
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
function calcSavingChip(kwh) {
  const costTesla = kwh * settings.comp_tesla_kwh;
  const costTanke = kwh * settings.comp_tanke_kwh;

  const r = calcTotal(kwh, settings.defaultEnergy, false);
  const wallbox = r.total;

  const savings = [
    { label: 'Tesla', saving: costTesla - wallbox },
    { label: 'Tanke', saving: costTanke - wallbox },
  ];

  return savings.reduce((a, b) => a.saving > b.saving ? a : b);
}

function savingChipHTML(kwh) {
  const best = calcSavingChip(kwh);
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
  const today = now.toISOString().split('T')[0];
  const nowTime = now.toTimeString().slice(0, 5);
  document.getElementById('inp-date').value = today;
  document.getElementById('inp-time').value = nowTime;
  document.getElementById('inp-energy').value = settings.defaultEnergy;

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
  const energy = parseFloat(document.getElementById('inp-energy').value) || 0;
  const date = document.getElementById('inp-date').value;
  const time = document.getElementById('inp-time').value;
  const snap = isSnap(date, time);
  const btn = document.getElementById('btn-save');

  if(kwh <= 0) {
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
['inp-date','inp-time'].forEach(id => {
  document.getElementById(id).addEventListener('change', updateCalc);
});

function saveCharge() {
  const kwh = parseFloat(document.getElementById('inp-kwh').value);
  const energy = parseFloat(document.getElementById('inp-energy').value);
  const date = document.getElementById('inp-date').value;
  const time = document.getElementById('inp-time').value;
  const snap = isSnap(date, time);

  if(!kwh || kwh <= 0) return;

  const r = calcTotal(kwh, energy, snap);

  charges.push({
    id: Date.now().toString(36) + Math.random().toString(36).substr(2,4),
    date: date,
    time: time || null,
    snap: snap,
    kwh: kwh,
    energyPrice: energy,
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
          <div class="tag"><div class="tag-label">Preis/kWh</div><div class="tag-value">${fmt(lc.bruttoPerKwh,2)} ct</div></div>
          <div class="tag"><div class="tag-label">Status</div><div class="tag-value" style="color:var(--green);white-space:nowrap;">● Abgeschlossen</div></div>
          ${lc.snap ? '<div class="tag"><div class="tag-label">Tarif</div><div class="tag-value" style="color:#16a34a;">☀️ SNAP –20%</div></div>' : ''}
          ${savingChipHTML(lc.kwh)}
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
              <div class="hi-saving">${(() => { const b = calcSavingChip(c.kwh); return b.saving > 0 ? `${b.label}: +${fmt(b.saving)} €` : ''; })()}</div>
            </div>
            <div class="hi-actions">
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
  renderChart(filtered);
  renderInsights();
  renderSavings();
  renderAmortisation();
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

  let startX = 0, currentX = 0, isDragging = false;

  el.addEventListener('touchstart', e => {
    startX = e.touches[0].clientX;
    isDragging = true;
    el.style.transition = 'none';
  }, {passive:true});

  el.addEventListener('touchmove', e => {
    if(!isDragging) return;
    currentX = e.touches[0].clientX;
    const diff = startX - currentX;
    if(diff > 0) {
      el.style.transform = `translateX(${-Math.min(diff, 120)}px)`;
    }
  }, {passive:true});

  el.addEventListener('touchend', () => {
    isDragging = false;
    el.style.transition = 'transform 0.3s ease';
    const diff = startX - currentX;
    if(diff > 80) {
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
function renderChart(data) {
  if(data.length === 0) {
    document.getElementById('chart-line-path').setAttribute('d','');
    document.getElementById('chart-area-path').setAttribute('d','');
    document.getElementById('chart-labels').innerHTML = '<span>Keine Daten</span>';
    document.getElementById('chart-badge').textContent = '';
    return;
  }

  // Aggregate by date
  const byDate = {};
  data.forEach(c => { byDate[c.date] = (byDate[c.date]||0) + c.total; });
  const dates = Object.keys(byDate).sort();
  const values = dates.map(d => byDate[d]);

  const w = 400, h = 120, pad = 4;
  const maxV = Math.max(...values, 1);
  const minV = Math.min(...values, 0);
  const range = maxV - minV || 1;

  const points = values.map((v,i) => {
    const x = pad + (i / Math.max(values.length-1,1)) * (w - pad*2);
    const y = h - pad - ((v - minV) / range) * (h - pad*2);
    return [x, y];
  });

  // Line
  let d = 'M ' + points.map(p => p[0]+' '+p[1]).join(' L ');
  document.getElementById('chart-line-path').setAttribute('d', d);

  // Area
  let areaD = d + ` L ${points[points.length-1][0]} ${h} L ${points[0][0]} ${h} Z`;
  document.getElementById('chart-area-path').setAttribute('d', areaD);

  // Labels
  const labelsEl = document.getElementById('chart-labels');
  if(dates.length <= 6) {
    labelsEl.innerHTML = dates.map(d => `<span>${fmtDateShort(d)}</span>`).join('');
  } else {
    const first = fmtDateShort(dates[0]);
    const last = fmtDateShort(dates[dates.length-1]);
    labelsEl.innerHTML = `<span>${first}</span><span>${last}</span>`;
  }

  // Badge
  const badge = document.getElementById('chart-badge');
  const totalFiltered = values.reduce((a,b)=>a+b,0);
  badge.textContent = fmt(totalFiltered) + ' €';
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

let importPreview = []; // Temporary storage for CSV preview

function processFile(file) {
  const reader = new FileReader();
  reader.onload = e => {
    const text = e.target.result;
    importPreview = [];

    if(file.name.endsWith('.json')) {
      try {
        const data = JSON.parse(text);
        const arr = Array.isArray(data) ? data : [data];
        arr.forEach(item => {
          if(item.date && item.kwh) {
            const ep = item.energy_price || item.energyPrice || settings.defaultEnergy;
            const exists = charges.some(c => c.date === item.date && Math.abs(c.kwh - item.kwh) < 0.01);
            if(exists) return;
            const r = calcTotal(item.kwh, ep);
            importPreview.push({
              id: Date.now().toString(36) + Math.random().toString(36).substr(2,4),
              date: item.date, kwh: item.kwh, energyPrice: ep,
              total: Math.round(r.total*100)/100, bruttoPerKwh: r.bruttoPerKwh,
              created: new Date().toISOString(),
            });
          }
        });
      } catch(err) { showToast('Fehler beim Parsen der JSON-Datei'); return; }
    } else {
      const lines = text.trim().replace(/\r/g, '').split('\n');
      const header = lines[0].toLowerCase();
      const isGoE = header.includes('energie [kwh]') || header.includes('session number');

      if(isGoE) {
        const cols = lines[0].split(';').map(c => c.trim().toLowerCase());
        const iStart = cols.findIndex(c => c === 'start');
        const iKwh = cols.findIndex(c => c.includes('energie'));
        const iMaxKw = cols.findIndex(c => c.includes('max. leistung'));
        const iDauer = cols.findIndex(c => c.includes('dauer gesamt'));
        const iDauerAktiv = cols.findIndex(c => c.includes('dauer aktiver stromfluss'));

        if(iStart === -1 || iKwh === -1) {
          showToast('go-e CSV erkannt, aber Spalten fehlen');
          return;
        }

        for(let i = 1; i < lines.length; i++) {
          const parts = lines[i].split(';');
          if(parts.length < Math.max(iStart, iKwh) + 1) continue;
          const startRaw = parts[iStart].trim();
          if(!startRaw) continue;
          const startParts = startRaw.split(' ');
          const dateParts = startParts[0].split('.');
          if(dateParts.length !== 3) continue;
          const date = `${dateParts[2]}-${dateParts[1].padStart(2,'0')}-${dateParts[0].padStart(2,'0')}`;
          const time = startParts[1] ? startParts[1].slice(0, 5) : '';
          const snap = isSnap(date, time);
          const kwh = parseFloat(parts[iKwh].trim().replace(',','.'));
          if(isNaN(kwh) || kwh <= 0) continue;
          const exists = charges.some(c => c.date === date && Math.abs(c.kwh - kwh) < 0.01);
          if(exists) continue;
          const maxKw = iMaxKw >= 0 ? parseFloat(parts[iMaxKw].trim().replace(',','.')) : null;
          const dauerGesamt = iDauer >= 0 ? parts[iDauer].trim() : null;
          const dauer = iDauerAktiv >= 0 ? parts[iDauerAktiv].trim() : null;
          const ep = settings.defaultEnergy;
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
          let ep = parts[2] ? parseFloat(parts[2].trim().replace(',','.')) : settings.defaultEnergy;
          if(!date || isNaN(kwh) || kwh <= 0) continue;
          if(date.includes('.')) {
            const dp = date.split('.');
            if(dp.length === 3) date = `${dp[2]}-${dp[1].padStart(2,'0')}-${dp[0].padStart(2,'0')}`;
          }
          const exists = charges.some(c => c.date === date && Math.abs(c.kwh - kwh) < 0.01);
          if(exists) continue;
          const r = calcTotal(kwh, ep);
          importPreview.push({
            id: Date.now().toString(36) + Math.random().toString(36).substr(2,4),
            date, kwh, energyPrice: ep,
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
  if(importPreview.length === 0) {
    area.innerHTML = `<div class="import-preview"><div style="text-align:center;color:var(--text-secondary);padding:12px;">Keine neuen Einträge gefunden (evtl. bereits importiert).</div></div>`;
    return;
  }

  const totalKwh = importPreview.reduce((s,c) => s + c.kwh, 0);
  const totalEur = importPreview.reduce((s,c) => s + c.total, 0);
  const show = importPreview.slice(0, 5);
  const more = importPreview.length - show.length;

  area.innerHTML = `
    <div class="import-preview">
      <div class="ip-header">
        <span class="ip-title">Vorschau</span>
        <span class="ip-count">${importPreview.length} Ladung${importPreview.length !== 1 ? 'en' : ''} erkannt</span>
      </div>
      ${show.map(c => `
        <div class="ip-entry">
          <span class="ip-date">${fmtDate(c.date)}</span>
          <span class="ip-kwh">${fmt(c.kwh,1)} kWh</span>
        </div>
      `).join('')}
      ${more > 0 ? `<div class="ip-more">+ ${more} weitere Einträge</div>` : ''}
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

  charges.push(...importPreview);
  charges.sort((a,b) => b.date.localeCompare(a.date));
  persist();

  importPreview = [];
  document.getElementById('import-result').innerHTML = '';
  showToast(`+${count} Ladungen • ${fmt(totalKwh,1)} kWh • ${fmt(totalEur)} €`);
}

function cancelImport() {
  importPreview = [];
  document.getElementById('import-result').innerHTML = '';
  showToast('Import abgebrochen');
}

function exportData() {
  const json = JSON.stringify(charges, null, 2);
  const blob = new Blob([json], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ladefuchs-export-${new Date().toISOString().split('T')[0]}.json`;
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
    document.getElementById('set-ev-kwh').value = settings.comp_ev_verbrauch_kwh;
    document.getElementById('set-benzin-preis').value = settings.comp_benzin_preis;
    document.getElementById('set-wallbox-installation').value = settings.comp_wallbox_installation;
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
  settings.comp_ev_verbrauch_kwh = parseFloat(document.getElementById('set-ev-kwh').value) || 20.0;
  settings.comp_benzin_preis = parseFloat(document.getElementById('set-benzin-preis').value) || 1.80;
  settings.comp_wallbox_installation = parseFloat(document.getElementById('set-wallbox-installation').value) || 2685.40;
  applyTheme();
  persist();
  toggleSettings();
  initAddPage();
  showToast('Einstellungen gespeichert');
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

  if (charges.length === 0) {
    area.innerHTML = '<div class="empty-state" style="padding:16px;">Noch keine Ladevorgänge erfasst.</div>';
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
    area.innerHTML = '<div style="color:var(--text-muted);font-size:14px;padding:8px 0;">Keine Daten im gewählten Zeitraum.</div>';
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

  function savingCard(label, icon, altCost, saving) {
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
      </div>
    `;
  }

  let html = `<div class="savings-grid">`;
  html += savingCard('Tesla Supercharger', '⚡', costTesla, savingTesla);
  html += savingCard('Tanke Wien kWh', '🔵', costTankeKwh, savingTankeKwh);
  if (hasZeit && costTankeZeit !== null) {
    html += savingCard('Tanke Wien Zeit', '🕐', costTankeZeit, savingTankeZeit);
  } else {
    html += `<div class="savings-card sc-disabled">
      <div class="sc-header"><span class="sc-icon">🕐</span><span class="sc-label">Tanke Wien Zeit</span></div>
      <div style="font-size:13px;color:var(--text-muted);padding:8px 0;">Ladezeit nicht verfügbar<br>(go-e CSV mit "Dauer aktiver Stromfluss" importieren)</div>
    </div>`;
  }
  // Benzin-Vergleich
  const kmEV = totalKwh / (s.comp_ev_verbrauch_kwh / 100);
  const costBenzin = kmEV * (s.comp_benzin_verbrauch_l / 100) * s.comp_benzin_preis;
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
        ℹ️ Benzinpreis: ${fmt(s.comp_benzin_preis, 3)} €/L (E-Control Wien)
      </div>
    </div>
  `;

  html += `</div>`;
  area.innerHTML = html;
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
    const benzinCost = km * (s.comp_benzin_verbrauch_l / 100) * s.comp_benzin_preis;
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

  area.innerHTML = `
    <div class="section-title">🏠 Amortisation Wallbox</div>
    <div class="savings-grid">
      ${amortCard('Tesla Supercharger', '⚡', savingTeslaAll)}
      ${amortCard('Tanke Wien kWh', '🔵', savingTankeAll)}
      ${amortCard('Benzin (Tiguan)', '⛽', savingBenzinAll)}
    </div>
  `;
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

  const ep = c.energyPrice || settings.defaultEnergy;
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
  const costBenzin = kmEV * (s.comp_benzin_verbrauch_l / 100) * s.comp_benzin_preis;

  function scCard(label, icon, altCost, saving) {
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
      </div>`;
  }

  const savingBenzin = costBenzin - myCost;
  let savingsHtml = `<div class="savings-grid">`;
  savingsHtml += scCard('Tesla Supercharger', '⚡', costTesla, costTesla - myCost);
  savingsHtml += scCard('Tanke Wien kWh', '🔵', costTankeKwh, costTankeKwh - myCost);
  if (hasZeit) {
    savingsHtml += scCard('Tanke Wien Zeit', '🕐', costTankeZeit, costTankeZeit - myCost);
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
      <div class="sc-abo">ℹ️ Benzinpreis: ${fmt(s.comp_benzin_preis, 3)} €/L (E-Control Wien)</div>
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
// INIT
// =====================================================================
initAddPage();
initImport();
refreshDashboard();
fetchBenzinpreis();
