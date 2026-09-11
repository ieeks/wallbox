// go-e reconciliation apply.
// Two phases by design:
// 1) identity-backfill: ONLY stable go-e identifiers are written for approved legacy matches.
// 2) apply: energy/peak/metadata corrections are allowed ONLY when zero legacy matches remain.
// A fresh encrypted backup/plan must have been generated and uploaded by the workflow before this script runs.

import admin from 'firebase-admin';
import fs from 'node:fs/promises';
import { applyPlanToCharges, buildReconciliationPlan, parseDataV3Csv } from '../../src/goe-reconciliation.js';
import {
  assertFinalApplyReady,
  assertIdentityBackfillReady,
  assertReconciliationGates,
  canonical,
  identityBackfillToCharges,
  matchMethodCounts,
  reconciliationHashes,
  sha256,
} from '../../src/goe-reconciliation-apply.js';

const serial = process.env.GOE_SERIAL;
const token = process.env.GOE_TOKEN;
const serviceAccountRaw = process.env.FIREBASE_SERVICE_ACCOUNT;
const phase = process.env.RECON_PHASE;
const validateOnly = process.env.RECON_VALIDATE_ONLY === '1';
const approvedPlanHashInput = process.env.APPROVED_PLAN_HASH || '';
const approvedLegacyRootInput = process.env.APPROVED_LEGACY_ROOT || '';
const confirmation = process.env.RECON_CONFIRM || '';

if (!serial || !token || !serviceAccountRaw) {
  throw new Error('GOE_SERIAL, GOE_TOKEN und FIREBASE_SERVICE_ACCOUNT sind erforderlich');
}
if (!['identity-backfill', 'apply'].includes(phase)) throw new Error('RECON_PHASE muss identity-backfill oder apply sein');

const serviceAccount = JSON.parse(serviceAccountRaw);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount), projectId: serviceAccount.project_id });
const db = admin.firestore();
const householdRef = db.collection('haushalte').doc('haushalt');

function findUrl(value) {
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value)) return value;
    if (value.startsWith('/')) return `https://${serial}.api.v3.go-e.io${value}`;
    return null;
  }
  if (Array.isArray(value)) {
    for (const v of value) { const found = findUrl(v); if (found) return found; }
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) { const found = findUrl(v); if (found) return found; }
  }
  return null;
}

async function fetchPreciseExport() {
  const statusRes = await fetch(`https://${serial}.api.v3.go-e.io/api/status`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!statusRes.ok) throw new Error(`go-e status HTTP ${statusRes.status}`);
  const status = await statusRes.json();
  const dll = findUrl(status.dll);
  if (!dll) throw new Error('go-e status.dll enthält keinen Export-Link');
  const portal = new URL(dll);
  const e = portal.searchParams.get('e');
  if (!e || portal.origin !== 'https://data.v3.go-e.io') throw new Error('Unerwartetes go-e Export-Link-Format');
  const direct = new URL('/api/v1/direct_export', portal.origin);
  direct.searchParams.set('e', e);
  const res = await fetch(direct, { redirect: 'follow' });
  if (!res.ok) throw new Error(`go-e direct_export HTTP ${res.status}`);
  const csv = await res.text();
  if (!csv.includes('Session Identifier')) throw new Error('go-e direct_export lieferte kein erwartetes data.v3 CSV');
  return csv;
}

function plain(value) {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (typeof value.toDate === 'function') return { $timestamp: value.toDate().toISOString() };
  if (typeof value.path === 'string' && value.constructor?.name === 'DocumentReference') return { $reference: value.path };
  if (Array.isArray(value)) return value.map(plain);
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
}

const sumKwh = values => +values.reduce((sum, value) => sum + (Number.isFinite(Number(value)) ? Number(value) : 0), 0).toFixed(3);

function planTotals(charges, sessions, plan, at) {
  const projected = applyPlanToCharges(charges, plan, at);
  return {
    sourceKwhTotal: sumKwh(sessions.map(s => s.energyKwh)),
    currentKwhTotal: sumKwh(charges.map(c => c.kwh)),
    projectedKwhTotal: sumKwh(projected.map(c => c.kwh)),
  };
}

async function loadPreparedSummary() {
  const raw = await fs.readFile('reconciliation-output/summary.json', 'utf8');
  const summary = JSON.parse(raw);
  if (summary.schemaVersion < 2 || !summary.planHash || !summary.currentFingerprint || !summary.sourceFingerprint) {
    throw new Error('Vorbereiteter Dry-Run enthält nicht die erforderlichen Apply-Gates');
  }
  return summary;
}

async function main() {
  const prepared = await loadPreparedSummary();
  const at = new Date().toISOString();
  const [householdSnap, csv] = await Promise.all([householdRef.get(), fetchPreciseExport()]);
  if (!householdSnap.exists) throw new Error('haushalte/haushalt existiert nicht');

  const rawCharges = Array.isArray(householdSnap.data()?.charges) ? householdSnap.data().charges : [];
  const charges = plain(rawCharges);
  const sessions = parseDataV3Csv(csv);
  const plan = buildReconciliationPlan(charges, sessions);
  const totals = planTotals(charges, sessions, plan, at);
  const hashes = reconciliationHashes(charges, csv, plan);
  assertReconciliationGates(plan, totals);

  if (hashes.currentFingerprint !== prepared.currentFingerprint) throw new Error('Current-Fingerprint hat sich seit dem frischen Backup geändert');
  if (hashes.sourceFingerprint !== prepared.sourceFingerprint) throw new Error('Source-Fingerprint hat sich seit dem frischen Backup geändert');
  if (hashes.planHash !== prepared.planHash) throw new Error('Plan hat sich seit dem frischen Backup geändert');
  if (hashes.legacyApprovalRoot !== (prepared.legacyApprovalRoot || null)) throw new Error('Legacy-Mapping-Root hat sich seit dem frischen Backup geändert');

  const approvedPlanHash = validateOnly ? prepared.planHash : approvedPlanHashInput;
  if (!/^[a-f0-9]{64}$/i.test(approvedPlanHash) || approvedPlanHash !== hashes.planHash) {
    throw new Error('approved_plan_hash stimmt nicht exakt mit dem aktuellen Plan überein');
  }

  let nextCharges;
  if (phase === 'identity-backfill') {
    const approvedLegacyRoot = validateOnly ? prepared.legacyApprovalRoot : approvedLegacyRootInput;
    assertIdentityBackfillReady(plan, approvedLegacyRoot, hashes.legacyApprovalRoot);
    if (!validateOnly && confirmation !== 'BACKFILL_IDENTITIES') {
      throw new Error('Bestätigung fehlt: RECON_CONFIRM muss BACKFILL_IDENTITIES sein');
    }
    nextCharges = identityBackfillToCharges(rawCharges, plan, at);
    const simulatedPlan = buildReconciliationPlan(plain(nextCharges), sessions);
    assertFinalApplyReady(simulatedPlan);
    if (simulatedPlan.summary.unmatchedSource || simulatedPlan.summary.unmatchedCharges) {
      throw new Error('Simulation nach Identity-Backfill ist nicht mehr 1:1 zuordenbar');
    }
  } else {
    assertFinalApplyReady(plan);
    if (!validateOnly && confirmation !== 'APPLY_RECONCILIATION') {
      throw new Error('Bestätigung fehlt: RECON_CONFIRM muss APPLY_RECONCILIATION sein');
    }
    nextCharges = applyPlanToCharges(rawCharges, plan, at);
    const nextPlain = plain(nextCharges);
    if (sumKwh(nextPlain.map(c => c.kwh)).toFixed(3) !== totals.sourceKwhTotal.toFixed(3)) {
      throw new Error('Simulation des Voll-Apply erreicht nicht exakt die data.v3-Zielsumme');
    }
    const simulatedPlan = buildReconciliationPlan(nextPlain, sessions);
    assertFinalApplyReady(simulatedPlan);
    if (simulatedPlan.summary.energyCorrections !== 0) throw new Error('Simulation des Voll-Apply lässt Energiekorrekturen offen');
  }

  const methods = matchMethodCounts(plan);
  console.log(`phase=${phase}`);
  console.log(`validateOnly=${validateOnly}`);
  console.log(`matched=${plan.summary.matched}`);
  console.log(`matchMethods=${JSON.stringify(methods)}`);
  console.log(`planHash=${hashes.planHash}`);
  console.log(`legacyApprovalRoot=${hashes.legacyApprovalRoot || 'none'}`);

  if (validateOnly) {
    console.log('VALIDATE_ONLY: alle Gates erfolgreich; keine Firestore-Daten verändert.');
    return;
  }

  // Recheck the external source immediately before the Firestore transaction.
  const csvAgain = await fetchPreciseExport();
  if (sha256(csvAgain) !== hashes.sourceFingerprint) throw new Error('go-e Source hat sich unmittelbar vor dem Write geändert');

  await db.runTransaction(async tx => {
    const snap = await tx.get(householdRef);
    if (!snap.exists) throw new Error('haushalte/haushalt ist vor dem Write verschwunden');
    const liveRawCharges = Array.isArray(snap.data()?.charges) ? snap.data().charges : [];
    const liveFingerprint = sha256(canonical(plain(liveRawCharges)));
    if (liveFingerprint !== hashes.currentFingerprint) {
      throw new Error('Firestore-Bestand hat sich unmittelbar vor dem Write geändert');
    }
    tx.update(householdRef, { charges: nextCharges });
  });

  const verifySnap = await householdRef.get();
  const verifyCharges = plain(Array.isArray(verifySnap.data()?.charges) ? verifySnap.data().charges : []);
  const expectedFingerprint = sha256(canonical(plain(nextCharges)));
  if (sha256(canonical(verifyCharges)) !== expectedFingerprint) throw new Error('Post-Write-Verifikation fehlgeschlagen');

  console.log(phase === 'identity-backfill'
    ? 'Identity-Backfill erfolgreich. Jetzt zwingend neuen Dry-Run ausführen; Voll-Apply bleibt bis 0 Legacy-Matches blockiert.'
    : `Reconciliation erfolgreich angewendet. Zielsumme=${totals.sourceKwhTotal.toFixed(3)} kWh.`);
}

main().catch(err => {
  console.error(`Reconciliation ${phase || 'unknown'} fehlgeschlagen: ${err.message}`);
  process.exit(1);
});
