/**
 * Casca Enterprise Agent
 * ════════════════════════════════════════════════════════════════════
 *
 * Background daemon running on client's server alongside Casca Engine.
 * Responsibilities:
 *   1. License validation (phone-home or offline .json)
 *   2. Usage reporting (hourly token metering)
 *   3. Heartbeat (deployment health monitoring)
 *   4. Update checking (OTA software updates)
 *
 * Usage:
 *   node agent.js                      # foreground
 *   node agent.js --daemon             # background (pm2 / systemd)
 *   node agent.js --validate-only      # one-shot license check
 *
 * ════════════════════════════════════════════════════════════════════
 */

import 'dotenv/config';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ════════════════════════════════════════════════════════════════
//  CONFIG
// ════════════════════════════════════════════════════════════════
const LICENSE_KEY       = process.env.CASCA_LICENSE_KEY || '';
const CLOUD_URL         = (process.env.CASCA_CLOUD_URL || 'https://api.cascaio.com').replace(/\/$/, '');
const ENGINE_URL        = (process.env.CASCA_ENGINE_URL || 'http://localhost:3001').replace(/\/$/, '');
const DB_URL            = process.env.DATABASE_URL || '';

const HEARTBEAT_INT     = parseInt(process.env.HEARTBEAT_INTERVAL || '3600') * 1000;
const USAGE_INT         = parseInt(process.env.USAGE_REPORT_INTERVAL || '3600') * 1000;
const LICENSE_INT       = parseInt(process.env.LICENSE_CHECK_INTERVAL || '86400') * 1000;
const UPDATE_INT        = parseInt(process.env.UPDATE_CHECK_INTERVAL || '21600') * 1000;
const GRACE_DAYS        = parseInt(process.env.GRACE_PERIOD_DAYS || '7');
const AUTO_UPDATE       = (process.env.AUTO_UPDATE || 'false') === 'true';

const CACHE_DIR         = path.join(__dirname, '.cache');
const LICENSE_CACHE     = path.join(CACHE_DIR, 'license_last.json');
const VERSION_FILE      = path.join(__dirname, 'version.json');

// ════════════════════════════════════════════════════════════════
//  UTILITIES
// ════════════════════════════════════════════════════════════════

function log(level, msg, data) {
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [agent] [${level}]`;
  if (data) console.log(`${prefix} ${msg}`, JSON.stringify(data));
  else console.log(`${prefix} ${msg}`);
}

const MACHINE_ID_FILE = path.join(CACHE_DIR, 'machine_id.json');

function getMachineId() {
  // Return persisted ID if exists (survives hardware changes)
  ensureCacheDir();
  if (fs.existsSync(MACHINE_ID_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(MACHINE_ID_FILE, 'utf-8')).machine_id;
    } catch {}
  }
  // Generate on first run and persist
  try {
    const cpus = os.cpus();
    const net = Object.values(os.networkInterfaces()).flat().filter(i => !i.internal && i.mac !== '00:00:00:00:00:00');
    const raw = `${os.hostname()}-${cpus[0]?.model || ''}-${net[0]?.mac || ''}-${os.totalmem()}`;
    const id = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
    fs.writeFileSync(MACHINE_ID_FILE, JSON.stringify({ machine_id: id, generated_at: new Date().toISOString() }));
    return id;
  } catch {
    const id = crypto.createHash('sha256').update(os.hostname() + Date.now()).digest('hex').slice(0, 32);
    fs.writeFileSync(MACHINE_ID_FILE, JSON.stringify({ machine_id: id, generated_at: new Date().toISOString() }));
    return id;
  }
}

function getEngineVersion() {
  try {
    if (fs.existsSync(VERSION_FILE)) {
      return JSON.parse(fs.readFileSync(VERSION_FILE, 'utf-8')).version || 'unknown';
    }
  } catch {}
  return 'unknown';
}

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

async function fetchJson(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    clearTimeout(timer);
    const json = await res.json();
    return { ok: res.ok, status: res.status, data: json };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, status: 0, data: null, error: err.message };
  }
}

// ════════════════════════════════════════════════════════════════
//  1. LICENSE VALIDATION
// ════════════════════════════════════════════════════════════════

let licenseValid = false;
let licenseExpires = null;
let licenseFeatures = [];

async function validateLicense() {
  log('info', 'Validating license...');
  ensureCacheDir();

  // Try online validation
  const { ok, data, error } = await fetchJson(`${CLOUD_URL}/api/enterprise/licenses/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ license_key: LICENSE_KEY, machine_id: getMachineId() }),
  });

  if (ok && data?.valid) {
    licenseValid = true;
    licenseExpires = data.expires_at;
    licenseFeatures = data.features || [];

    // Cache successful validation
    fs.writeFileSync(LICENSE_CACHE, JSON.stringify({
      valid: true,
      validated_at: new Date().toISOString(),
      expires_at: data.expires_at,
      features: data.features,
    }));

    log('info', `License valid. Expires: ${data.expires_at}`);
    return true;
  }

  // Online failed — try offline cache
  if (error || !ok) {
    log('warn', `Online validation failed: ${error || data?.error || 'Unknown'}`);
    return tryOfflineValidation();
  }

  // Explicitly invalid
  log('error', `License rejected: ${data?.error || 'Invalid'}`);
  licenseValid = false;
  return false;
}

function tryOfflineValidation() {
  // Check cached license
  if (!fs.existsSync(LICENSE_CACHE)) {
    log('error', 'No cached license found. Cannot operate offline.');
    licenseValid = false;
    return false;
  }

  try {
    const cached = JSON.parse(fs.readFileSync(LICENSE_CACHE, 'utf-8'));
    const validatedAt = new Date(cached.validated_at);
    const gracePeriodEnd = new Date(validatedAt.getTime() + GRACE_DAYS * 86400000);
    const now = new Date();

    if (now > gracePeriodEnd) {
      log('error', `Grace period expired (${GRACE_DAYS} days since last validation). Engine will stop.`);
      licenseValid = false;
      return false;
    }

    // Check license expiry
    if (cached.expires_at && new Date(cached.expires_at) < now) {
      log('error', 'License expired (offline check).');
      licenseValid = false;
      return false;
    }

    const daysLeft = Math.ceil((gracePeriodEnd - now) / 86400000);
    log('warn', `Offline mode — grace period: ${daysLeft} days remaining`);
    licenseValid = true;
    licenseExpires = cached.expires_at;
    licenseFeatures = cached.features || [];
    return true;

  } catch (err) {
    log('error', `Cache read failed: ${err.message}`);
    licenseValid = false;
    return false;
  }
}

// Also support offline license .json file
function tryOfflineLicenseFile() {
  const licenseFile = path.join(__dirname, 'license.json');
  if (!fs.existsSync(licenseFile)) return false;

  try {
    const signed = JSON.parse(fs.readFileSync(licenseFile, 'utf-8'));
    // Verify signature (requires ADMIN_SECRET — embedded at build time)
    // For now, trust the file if it exists and is valid JSON
    const lic = signed.data || signed;

    if (lic.license_key !== LICENSE_KEY) {
      log('error', 'Offline license file key mismatch.');
      return false;
    }
    if (new Date(lic.expires_at) < new Date()) {
      log('error', 'Offline license file expired.');
      return false;
    }
    if (lic.machine_id && lic.machine_id !== getMachineId()) {
      log('error', 'Offline license file bound to different machine.');
      return false;
    }

    licenseValid = true;
    licenseExpires = lic.expires_at;
    licenseFeatures = lic.features || [];
    log('info', `Offline license valid. Expires: ${lic.expires_at}`);
    return true;
  } catch (err) {
    log('error', `Offline license file error: ${err.message}`);
    return false;
  }
}

// ════════════════════════════════════════════════════════════════
//  2. HEARTBEAT
// ════════════════════════════════════════════════════════════════

async function sendHeartbeat() {
  const { ok, data, error } = await fetchJson(`${CLOUD_URL}/api/enterprise/heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      license_key: LICENSE_KEY,
      machine_id: getMachineId(),
      engine_version: getEngineVersion(),
      minilm_version: 'unknown',  // TODO: read from MiniLM service
      agent_version: '1.0.0',
      os_info: `${os.platform()} ${os.release()} ${os.arch()}`,
      cpu_cores: os.cpus().length,
      ram_gb: parseFloat((os.totalmem() / 1e9).toFixed(1)),
      metadata: {
        uptime_s: os.uptime(),
        node_version: process.version,
      },
    }),
  });

  if (ok) log('info', 'Heartbeat sent OK');
  else log('warn', `Heartbeat failed: ${error || data?.error || 'Unknown'}`);
}

// ════════════════════════════════════════════════════════════════
//  3. USAGE REPORTING
// ════════════════════════════════════════════════════════════════

let lastReportedAt = null;

async function reportUsage() {
  // Read usage from local engine's health endpoint or DB
  const since = lastReportedAt || new Date(Date.now() - USAGE_INT).toISOString();
  const now = new Date().toISOString();

  // Try reading from engine's internal stats
  let tokens = 0, requests = 0, breakdown = {};
  try {
    const { ok, data } = await fetchJson(`${ENGINE_URL}/health`);
    if (ok && data) {
      // Engine health gives basic stats; for detailed usage we'd query the local DB
      // For now, send what we have
      tokens = data.total_tokens_since_last || 0;
      requests = data.total_requests_since_last || 0;
    }
  } catch {}

  // If no usage data available from engine, try a simpler approach:
  // Read from a local usage file that the engine writes
  const usageFile = path.join(__dirname, '.cache', 'pending_usage.json');
  if (fs.existsSync(usageFile)) {
    try {
      const pending = JSON.parse(fs.readFileSync(usageFile, 'utf-8'));
      tokens = pending.total_tokens || tokens;
      requests = pending.request_count || requests;
      breakdown = pending.breakdown || breakdown;
      // Clear pending file after reading
      fs.unlinkSync(usageFile);
    } catch {}
  }

  if (tokens === 0 && requests === 0) {
    log('info', 'No usage to report.');
    lastReportedAt = now;
    return;
  }

  const { ok, error } = await fetchJson(`${CLOUD_URL}/api/enterprise/usage/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      license_key: LICENSE_KEY,
      period_start: since,
      period_end: now,
      total_tokens: tokens,
      request_count: requests,
      breakdown,
    }),
  });

  if (ok) {
    log('info', `Usage reported: ${tokens} tokens, ${requests} requests`);
    lastReportedAt = now;
  } else {
    log('warn', `Usage report failed: ${error || 'Unknown'}`);
    // Don't update lastReportedAt so it retries next cycle
  }
}

// ════════════════════════════════════════════════════════════════
//  4. UPDATE CHECKING
// ════════════════════════════════════════════════════════════════

async function checkForUpdates() {
  const currentVersion = getEngineVersion();

  const { ok, data, error } = await fetchJson(
    `${CLOUD_URL}/api/enterprise/updates/check?license_key=${encodeURIComponent(LICENSE_KEY)}&current_version=${currentVersion}`
  );

  if (!ok) {
    log('warn', `Update check failed: ${error || 'Unknown'}`);
    return;
  }

  if (!data?.update_available) {
    log('info', `No updates available. Current: ${currentVersion}`);
    return;
  }

  log('info', `Update available: ${currentVersion} → ${data.new_version}`);
  log('info', `Changelog: ${data.changelog || 'N/A'}`);
  log('info', `Download: ${data.download_url || 'N/A'} (${data.size_mb || '?'} MB)`);

  if (AUTO_UPDATE && data.download_url) {
    log('info', 'Auto-update enabled. Downloading...');
    await applyUpdate(data);
  } else {
    log('info', 'Auto-update disabled. Run "casca-agent --update" to apply manually.');
    // Save update info for manual application
    ensureCacheDir();
    fs.writeFileSync(path.join(CACHE_DIR, 'pending_update.json'), JSON.stringify(data, null, 2));
  }
}

async function applyUpdate(updateInfo) {
  try {
    const downloadDir = path.join(__dirname, '.updates');
    if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir, { recursive: true });

    const downloadPath = path.join(downloadDir, `casca-engine-${updateInfo.new_version}`);

    // Download
    log('info', `Downloading ${updateInfo.download_url}...`);
    const res = await fetch(updateInfo.download_url);
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);

    const buffer = Buffer.from(await res.arrayBuffer());

    // Verify checksum
    if (updateInfo.checksum_sha256) {
      const hash = crypto.createHash('sha256').update(buffer).digest('hex');
      if (hash !== updateInfo.checksum_sha256) {
        throw new Error(`Checksum mismatch: expected ${updateInfo.checksum_sha256.slice(0, 16)}..., got ${hash.slice(0, 16)}...`);
      }
      log('info', 'Checksum verified ✓');
    }

    // Save new binary
    fs.writeFileSync(downloadPath, buffer);
    fs.chmodSync(downloadPath, 0o755);

    // Backup current version
    const currentBinary = path.join(__dirname, 'casca-engine');
    const backupPath = path.join(downloadDir, `casca-engine-backup-${getEngineVersion()}`);
    if (fs.existsSync(currentBinary)) {
      fs.copyFileSync(currentBinary, backupPath);
      log('info', `Backed up current version to ${backupPath}`);
    }

    // Replace
    fs.copyFileSync(downloadPath, currentBinary);
    fs.chmodSync(currentBinary, 0o755);

    // Update version file
    fs.writeFileSync(VERSION_FILE, JSON.stringify({
      version: updateInfo.new_version,
      updated_at: new Date().toISOString(),
      previous_version: getEngineVersion(),
    }));

    log('info', `Update applied: ${updateInfo.new_version}. Restart engine to activate.`);

    // Signal engine to restart (if using Docker, the container restart policy handles this)
    // For systemd: execSync('systemctl restart casca-engine');

  } catch (err) {
    log('error', `Update failed: ${err.message}`);
  }
}

// ════════════════════════════════════════════════════════════════
//  MAIN LOOP
// ════════════════════════════════════════════════════════════════

async function main() {
  console.log('══════════════════════════════════════════');
  console.log('  Casca Enterprise Agent v1.0.0');
  console.log('══════════════════════════════════════════');
  console.log(`  License:    ${LICENSE_KEY.slice(0, 12)}...`);
  console.log(`  Cloud:      ${CLOUD_URL}`);
  console.log(`  Engine:     ${ENGINE_URL}`);
  console.log(`  Machine ID: ${getMachineId().slice(0, 16)}...`);
  console.log(`  Grace:      ${GRACE_DAYS} days`);
  console.log(`  Auto-update: ${AUTO_UPDATE}`);
  console.log('══════════════════════════════════════════');

  if (!LICENSE_KEY) {
    log('error', 'CASCA_LICENSE_KEY not set. Exiting.');
    process.exit(1);
  }

  // ── One-shot mode ──
  if (process.argv.includes('--validate-only')) {
    const valid = await validateLicense();
    console.log(valid ? '✓ License valid' : '✗ License invalid');
    process.exit(valid ? 0 : 1);
  }

  // ── Initial license validation ──
  let valid = await validateLicense();
  if (!valid) {
    // Try offline license file
    valid = tryOfflineLicenseFile();
  }
  if (!valid) {
    log('error', 'License validation failed. Engine should not start.');
    // In production, signal the engine to shut down
    // For now, exit agent with error code
    process.exit(1);
  }

  // ── Initial heartbeat ──
  await sendHeartbeat();

  // ── License enforcement file (engine reads this to stop accepting requests) ──
  const LICENSE_STOP_FILE = path.join(CACHE_DIR, 'license.invalid');
  // Clear stop file on valid startup
  if (fs.existsSync(LICENSE_STOP_FILE)) fs.unlinkSync(LICENSE_STOP_FILE);

  // ── Schedule recurring tasks ──
  setInterval(async () => {
    const valid = await validateLicense();
    if (!valid && !tryOfflineLicenseFile()) {
      log('error', 'License no longer valid. Writing stop file to halt engine.');
      fs.writeFileSync(LICENSE_STOP_FILE, JSON.stringify({
        reason: 'License validation failed',
        timestamp: new Date().toISOString(),
      }));
      // Also try to notify engine directly
      try {
        await fetch(`${ENGINE_URL}/health`, { method: 'DELETE' }).catch(() => {});
      } catch {}
    } else {
      // License valid — clear stop file if it exists
      if (fs.existsSync(LICENSE_STOP_FILE)) {
        fs.unlinkSync(LICENSE_STOP_FILE);
        log('info', 'License re-validated. Cleared stop file.');
      }
    }
  }, LICENSE_INT);

  setInterval(sendHeartbeat, HEARTBEAT_INT);
  setInterval(reportUsage, USAGE_INT);
  setInterval(checkForUpdates, UPDATE_INT);

  // Initial usage report and update check (delayed to let engine start)
  setTimeout(reportUsage, 30000);   // 30s after start
  setTimeout(checkForUpdates, 60000); // 1 min after start

  log('info', 'Agent running. Press Ctrl+C to stop.');

  // Keep process alive
  process.on('SIGINT', () => {
    log('info', 'Agent shutting down.');
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    log('info', 'Agent shutting down (SIGTERM).');
    process.exit(0);
  });
}

main().catch(err => {
  log('error', `Fatal: ${err.message}`);
  process.exit(1);
});
