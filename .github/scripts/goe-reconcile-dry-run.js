// P1 go-e reconciliation dry-run.
// SAFETY: This file contains no Firestore write/delete operations. It reads the
// live state, downloads the precise go-e data.v3 export, builds a plan and writes
// only AES-256-GCM encrypted local artifacts for GitHub Actions upload.

import admin from 'firebase-admin';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { applyPlanToCharges, buildReconciliationPlan, parseDataV3Csv } from '../../src/goe-reconciliation.js';

const serial = process.env.GOE_SERIAL;
const token = process.env.GOE_TOKEN;
const serviceAccountRaw = process.env.FIREBASE_SERVICE_ACCOUNT;
const backupKeyRaw = process.env.RECON_BACKUP_KEY;
if (!serial || !token || !serviceAccountRaw || !backupKeyRaw) {
  throw new Error('GOE_SERIAL, GOE_TOKEN, FIREBASE_SERVICE_ACCOUNT und RECON_BACKUP_KEY sind erforderlich');
}
const backupKeyBytes = Buffer.from(backupKeyRaw, 'base64');
if (backupKeyBytes.length < 32) throw new Error('RECON_BACKUP_KEY muss mindestens 32 zufällige Bytes als Base64 enthalten');

const serviceAccount = JSON.parse(serviceAccountRaw);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount), projectId: serviceAccount.project_id });
const db = admin.firestore();

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
  const exportRes = await fetch(direct, { redirect: 'follow' });
  if (!exportRes.ok) throw new Error(`go-e direct_export HTTP ${exportRes.status}`);
  const contentType = exportRes.headers.get('content-type') || '';
  const csv = await exportRes.text();
  if (!/text\/csv/i.test(contentType) && !csv.includes('Session Identifier')) {
    throw new Error(`go-e direct_export lieferte kein erwartetes CSV (${contentType || 'ohne Content-Type'})`);
  }
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

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const sumKwh = values => +values.reduce((sum, value) => sum + (Number.isFinite(Number(value)) ? Number(value) : 0), 0).toFixed(3);

function encryptJson(value) {
  const key = crypto.createHash('sha256')
    .update('ladefuchs-goe-reconciliation-backup-v1\0')
    .update(backupKeyBytes)
    .digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    schema: 'ladefuchs-encrypted-artifact-v1',
    algorithm: 'AES-256-GCM',
    keyHint: 'SHA-256(context + RECON_BACKUP_KEY)',
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

async function readDoc(ref) {
  const snap = await ref.get();
  return { path: ref.path, exists: snap.exists, data: snap.exists ? plain(snap.data()) : null };
}

async function readTrips() {
  const snap = await db.collection('haushalte').doc('haushalt').collection('trips').get();
  return snap.docs.map(doc => ({ path: doc.ref.path, id: doc.id, data: plain(doc.data()) }));
}

async function main() {
  const createdAt = new Date().toISOString();
  const [csv, household, deletions, importState, peakTracker, trips] = await Promise.all([
    fetchPreciseExport(),
    readDoc(db.collection('haushalte').doc('haushalt')),
    readDoc(db.collection('haushalte').doc('charge-deletions')),
    readDoc(db.collection('haushalte').doc('goe-import-state')),
    readDoc(db.collection('haushalte').doc('goe-peak-tracker')),
    readTrips(),
  ]);

  if (!household.exists) throw new Error('haushalte/haushalt existiert nicht');
  const charges = Array.isArray(household.data?.charges) ? household.data.charges : [];
  const sessions = parseDataV3Csv(csv);
  const plan = buildReconciliationPlan(charges, sessions);
  const projectedCharges = applyPlanToCharges(charges, plan, createdAt);
  const sourceKwhTotal = sumKwh(sessions.map(s => s.energyKwh));
  const meterSpanKwhTotal = sumKwh(sessions.map(s => s.meterSpanKwh));
  const currentKwhTotal = sumKwh(charges.map(c => c.kwh));
  const projectedKwhTotal = sumKwh(projectedCharges.map(c => c.kwh));
  const currentFingerprint = sha256(canonical(charges));
  const sourceFingerprint = sha256(csv);
  const planPayload = {
    schemaVersion: 1,
    mode: 'dry-run',
    createdAt,
    currentFingerprint,
    sourceFingerprint,
    sourceCsv: csv,
    sourceSessions: sessions,
    plan,
    totals: { sourceKwhTotal, meterSpanKwhTotal, currentKwhTotal, projectedKwhTotal },
  };
  const planHash = sha256(canonical({ currentFingerprint, sourceFingerprint, plan }));
  planPayload.planHash = planHash;

  const backup = {
    schemaVersion: 1,
    createdAt,
    purpose: 'pre-go-e-reconciliation',
    firestore: { household, deletions, importState, peakTracker, trips },
    currentFingerprint,
  };

  const outDir = path.resolve('reconciliation-output');
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'firestore-backup.enc.json'), JSON.stringify(encryptJson(backup)));
  await fs.writeFile(path.join(outDir, 'reconciliation-plan.enc.json'), JSON.stringify(encryptJson(planPayload)));
  await fs.writeFile(path.join(outDir, 'summary.json'), JSON.stringify({
    schemaVersion: 1,
    createdAt,
    planHash: planHash.slice(0, 16),
    ...plan.summary,
    sourceKwhTotal,
    meterSpanKwhTotal,
    currentKwhTotal,
    projectedKwhTotal,
  }, null, 2));

  const s = plan.summary;
  console.log('=== go-e reconciliation dry-run ===');
  console.log(`sourceSessions=${s.sourceSessions}`);
  console.log(`currentCharges=${s.currentCharges}`);
  console.log(`matched=${s.matched}`);
  console.log(`unmatchedSource=${s.unmatchedSource}`);
  console.log(`unmatchedCharges=${s.unmatchedCharges}`);
  console.log(`energyCorrections=${s.energyCorrections}`);
  console.log(`largeMismatches=${s.largeMismatches}`);
  console.log(`metadataChanges=${s.metadataChanges}`);
  console.log(`sourceInconsistencies=${s.sourceInconsistencies}`);
  console.log(`sourceKwhTotal=${sourceKwhTotal.toFixed(3)}`);
  console.log(`meterSpanKwhTotal=${meterSpanKwhTotal.toFixed(3)}`);
  console.log(`currentKwhTotal=${currentKwhTotal.toFixed(3)}`);
  console.log(`projectedKwhTotal=${projectedKwhTotal.toFixed(3)}`);
  console.log(`tripBackupDocuments=${trips.length}`);
  console.log(`planHash=${planHash.slice(0, 16)}`);
  console.log('Keine Firestore-Daten wurden verändert. Detailplan und Backup liegen ausschließlich verschlüsselt im Artefakt.');

  if (s.sourceInconsistencies > 0) {
    console.log('::warning::Mindestens eine go-e-Session hat eine inkonsistente Energie/Zählerspanne; diese wird nicht automatisch korrigiert.');
  }
  if (s.unmatchedSource > 0 || s.unmatchedCharges > 0) {
    console.log('::warning::Nicht alle Sessions konnten 1:1 zugeordnet werden. Apply muss bis zur Klärung blockiert bleiben.');
  }
  if (s.unmatchedSource === 0 && s.unmatchedCharges === 0 && s.sourceInconsistencies === 0 && projectedKwhTotal !== sourceKwhTotal) {
    throw new Error(`Projizierte Summe ${projectedKwhTotal.toFixed(3)} kWh entspricht nicht der Quelle ${sourceKwhTotal.toFixed(3)} kWh`);
  }
}

main().catch(err => {
  console.error(`Dry-run fehlgeschlagen: ${err.message}`);
  process.exit(1);
});
