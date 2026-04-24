/**
 * casca-enterprise-api.js — Enterprise License, Usage, Deployment, Update APIs
 * ════════════════════════════════════════════════════════════════════
 *
 * Imported by server-v2.js: registerEnterpriseRoutes(app, supabase)
 *
 * Endpoints:
 *   /api/enterprise/licenses       — CRUD + offline .json generation
 *   /api/enterprise/heartbeat      — Agent health check
 *   /api/enterprise/usage/report   — Agent usage submission
 *   /api/enterprise/updates/check  — Agent update check
 *   /api/enterprise/deployments    — Deployment list
 *   /api/enterprise/audit          — Audit log query
 * ════════════════════════════════════════════════════════════════════
 */

import crypto from 'crypto';
import fs from 'fs';

// ════════════════════════════════════════════════════════════════
//  OFFLINE LICENSE SIGNING — RSA-4096
//  Private key: env var LICENSE_SIGNING_KEY (or file)
//  Public key:  embedded in agent binary for verification
// ════════════════════════════════════════════════════════════════

function getSigningKey() {
  // Try env var first, then file
  if (process.env.LICENSE_SIGNING_KEY) return process.env.LICENSE_SIGNING_KEY;
  try {
    const keyPath = new URL('./casca-enterprise-build/security/license-private.pem', import.meta.url);
    return fs.readFileSync(keyPath, 'utf-8');
  } catch { return null; }
}

function signLicense(payload) {
  const privateKey = getSigningKey();
  if (!privateKey) throw new Error('LICENSE_SIGNING_KEY not configured. Run generate-keys.sh first.');
  const data = JSON.stringify(payload);
  const sig = crypto.createSign('SHA256').update(data).sign(privateKey, 'hex');
  return { data: payload, signature: sig, algorithm: 'RSA-SHA256' };
}

function verifyLicenseSignature(license, publicKey) {
  try {
    const verify = crypto.createVerify('SHA256');
    verify.update(JSON.stringify(license.data));
    return verify.verify(publicKey, license.signature, 'hex');
  } catch { return false; }
}

// ════════════════════════════════════════════════════════════════
//  RATE LIMITING — per license_key for agent endpoints
// ════════════════════════════════════════════════════════════════
const agentRateLimits = new Map(); // key → { count, resetAt }
setInterval(() => agentRateLimits.clear(), 120_000); // cleanup every 2 min

function checkAgentRateLimit(licenseKey, maxPerMinute = 30) {
  const now = Date.now();
  const bucket = agentRateLimits.get(licenseKey) || { count: 0, resetAt: now + 60_000 };
  if (now >= bucket.resetAt) { bucket.count = 1; bucket.resetAt = now + 60_000; }
  else if (bucket.count >= maxPerMinute) return false;
  else bucket.count++;
  agentRateLimits.set(licenseKey, bucket);
  return true;
}

// ════════════════════════════════════════════════════════════════
//  SHARED: validate license key + expiry + active
// ════════════════════════════════════════════════════════════════
async function validateAgentLicense(supabase, licenseKey, req) {
  if (!licenseKey) return { valid: false, status: 400, error: 'license_key required.' };
  if (!checkAgentRateLimit(licenseKey)) return { valid: false, status: 429, error: 'Rate limit exceeded.' };

  const { data: license } = await supabase
    .from('enterprise_licenses')
    .select('id, is_active, expires_at, machine_id')
    .eq('license_key', licenseKey)
    .maybeSingle();

  if (!license || !license.is_active) return { valid: false, status: 403, error: 'Invalid or revoked license.' };
  if (new Date(license.expires_at) < new Date()) {
    await supabase.from('enterprise_audit').insert({
      license_id: license.id, event_type: 'LICENSE_EXPIRED',
      detail: { expired_at: license.expires_at }, actor: 'agent', ip_address: req?.ip,
    });
    return { valid: false, status: 403, error: 'License expired.', expired_at: license.expires_at };
  }

  return { valid: true, license };
}

export function registerEnterpriseRoutes(app, supabase, requireAdmin) {
  const ADMIN_SECRET = process.env.ADMIN_SECRET || '';

  // ════════════════════════════════════════════════════════════
  //  LICENSE MANAGEMENT
  // ════════════════════════════════════════════════════════════

  /** GET /api/enterprise/licenses — List all licenses */
  app.get('/api/enterprise/licenses', requireAdmin, async (req, res) => {
    const { data, error } = await supabase
      .from('enterprise_licenses')
      .select('*, enterprise_deployments(id, status, last_heartbeat, engine_version)')
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });

    // Enrich with usage summary
    const now = new Date();
    const { data: usage } = await supabase.rpc('enterprise_monthly_summary', {
      p_year: now.getFullYear(),
      p_month: now.getMonth() + 1,
    });
    const usageMap = {};
    for (const u of (usage || [])) usageMap[u.license_id] = u;

    const licenses = (data || []).map(l => ({
      ...l,
      deployment: l.enterprise_deployments?.[0] || null,
      current_month_tokens: usageMap[l.id]?.total_tokens || 0,
      current_month_requests: usageMap[l.id]?.total_requests || 0,
    }));

    return res.json({ licenses });
  });

  /** POST /api/enterprise/licenses — Create new license */
  app.post('/api/enterprise/licenses', requireAdmin, async (req, res) => {
    const { client_name, client_contact, license_type, machine_id,
            features, token_limit_monthly, max_qps, expires_months, notes } = req.body;

    if (!client_name) return res.status(400).json({ error: 'client_name required.' });

    // Generate license key
    const { data: keyData } = await supabase.rpc('gen_enterprise_license_key');
    const license_key = keyData || ('ent_' + crypto.randomBytes(16).toString('hex'));

    const expires = new Date();
    expires.setMonth(expires.getMonth() + (expires_months || 12));

    const { data, error } = await supabase.from('enterprise_licenses').insert({
      client_name,
      client_contact: client_contact || null,
      license_key,
      license_type: license_type || 'online',
      machine_id: machine_id || null,
      features: features || ['L1', 'L2', 'cache'],
      token_limit_monthly: token_limit_monthly || 0,
      max_qps: max_qps || 100,
      expires_at: expires.toISOString(),
      notes: notes || null,
    }).select().single();

    if (error) return res.status(500).json({ error: error.message });

    // Audit
    await supabase.from('enterprise_audit').insert({
      license_id: data.id,
      event_type: 'LICENSE_GEN',
      detail: { client_name, license_type: license_type || 'online', expires_months: expires_months || 12 },
      actor: 'admin',
    });

    console.log(`[enterprise] license created: ${client_name} → ${license_key.slice(0, 12)}...`);
    return res.status(201).json({ license: data });
  });

  /** PATCH /api/enterprise/licenses/:id — Update license */
  app.patch('/api/enterprise/licenses/:id', requireAdmin, async (req, res) => {
    const allowed = ['client_name', 'client_contact', 'machine_id', 'features',
                     'token_limit_monthly', 'max_qps', 'is_active', 'notes'];
    const updates = {};
    for (const k of allowed) if (req.body[k] !== undefined) updates[k] = req.body[k];

    // Handle renew (extend expiry)
    if (req.body.extend_months) {
      const { data: current } = await supabase
        .from('enterprise_licenses')
        .select('expires_at')
        .eq('id', req.params.id)
        .single();
      if (current) {
        const base = new Date(current.expires_at) > new Date() ? new Date(current.expires_at) : new Date();
        base.setMonth(base.getMonth() + req.body.extend_months);
        updates.expires_at = base.toISOString();
      }
    }

    // Handle revoke
    if (req.body.revoke === true) {
      updates.is_active = false;
      await supabase.from('enterprise_audit').insert({
        license_id: req.params.id,
        event_type: 'LICENSE_REVOKE',
        detail: { reason: req.body.reason || 'Admin revoked' },
        actor: 'admin',
      });
    }

    updates.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('enterprise_licenses')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ license: data });
  });

  /** POST /api/enterprise/licenses/:id/offline — Generate offline license .json */
  app.post('/api/enterprise/licenses/:id/offline', requireAdmin, async (req, res) => {
    const { data: license, error } = await supabase
      .from('enterprise_licenses')
      .select('*')
      .eq('id', req.params.id)
      .single();
    if (error || !license) return res.status(404).json({ error: 'License not found.' });

    const payload = {
      license_key: license.license_key,
      client_name: license.client_name,
      machine_id: license.machine_id,
      features: license.features,
      token_limit_monthly: license.token_limit_monthly,
      max_qps: license.max_qps,
      expires_at: license.expires_at,
      issued_at: new Date().toISOString(),
      issuer: 'casca-cloud',
      version: 1,
    };

    let signed;
    try { signed = signLicense(payload); }
    catch (err) { return res.status(500).json({ error: err.message }); }

    // Audit
    await supabase.from('enterprise_audit').insert({
      license_id: license.id,
      event_type: 'LICENSE_OFFLINE_GEN',
      detail: { expires_at: license.expires_at },
      actor: 'admin',
    });

    res.setHeader('Content-Disposition', `attachment; filename="casca-license-${license.client_name.replace(/\s+/g, '_')}.json"`);
    res.setHeader('Content-Type', 'application/json');
    return res.json(signed);
  });

  // ════════════════════════════════════════════════════════════
  //  AGENT ENDPOINTS (called by on-prem Casca Agent)
  // ════════════════════════════════════════════════════════════

  /** POST /api/enterprise/licenses/validate — Agent phone-home */
  app.post('/api/enterprise/licenses/validate', async (req, res) => {
    const { license_key, machine_id } = req.body;
    if (!license_key) return res.status(400).json({ error: 'license_key required.' });

    const { data: license } = await supabase
      .from('enterprise_licenses')
      .select('*')
      .eq('license_key', license_key)
      .eq('is_active', true)
      .maybeSingle();

    if (!license) {
      return res.status(403).json({ valid: false, error: 'Invalid or revoked license.' });
    }

    // Check expiry
    if (new Date(license.expires_at) < new Date()) {
      await supabase.from('enterprise_audit').insert({
        license_id: license.id,
        event_type: 'LICENSE_EXPIRED',
        detail: { expired_at: license.expires_at },
        actor: 'agent',
        ip_address: req.ip,
      });
      return res.status(403).json({ valid: false, error: 'License expired.', expired_at: license.expires_at });
    }

    // Check machine binding
    if (license.machine_id && machine_id && license.machine_id !== machine_id) {
      return res.status(403).json({
        valid: false,
        error: 'License bound to different machine.',
        expected: license.machine_id.slice(0, 8) + '...',
      });
    }

    // Audit
    await supabase.from('enterprise_audit').insert({
      license_id: license.id,
      event_type: 'LICENSE_OK',
      detail: { machine_id },
      actor: 'agent',
      ip_address: req.ip,
    });

    return res.json({
      valid: true,
      expires_at: license.expires_at,
      features: license.features,
      token_limit_monthly: license.token_limit_monthly,
      max_qps: license.max_qps,
    });
  });

  /** POST /api/enterprise/heartbeat — Agent health check */
  app.post('/api/enterprise/heartbeat', async (req, res) => {
    const { license_key, machine_id, engine_version, minilm_version,
            agent_version, os_info, cpu_cores, ram_gb, metadata } = req.body;

    const check = await validateAgentLicense(supabase, license_key, req);
    if (!check.valid) return res.status(check.status).json({ error: check.error });
    const license = check.license;

    // Upsert deployment record
    await supabase.from('enterprise_deployments').upsert({
      license_id: license.id,
      machine_id: machine_id || null,
      engine_version: engine_version || null,
      minilm_version: minilm_version || null,
      agent_version: agent_version || null,
      os_info: os_info || null,
      cpu_cores: cpu_cores || null,
      ram_gb: ram_gb || null,
      last_heartbeat: new Date().toISOString(),
      status: 'online',
      metadata: metadata || {},
      updated_at: new Date().toISOString(),
    }, { onConflict: 'license_id' });

    return res.json({ ok: true, server_time: new Date().toISOString() });
  });

  /** POST /api/enterprise/usage/report — Agent usage submission */
  app.post('/api/enterprise/usage/report', async (req, res) => {
    const { license_key, period_start, period_end,
            total_tokens, request_count, breakdown } = req.body;

    const check = await validateAgentLicense(supabase, license_key, req);
    if (!check.valid) return res.status(check.status).json({ error: check.error });
    const license = check.license;

    const { error } = await supabase.from('enterprise_usage').insert({
      license_id: license.id,
      period_start,
      period_end,
      total_tokens: total_tokens || 0,
      request_count: request_count || 0,
      breakdown: breakdown || {},
    });
    if (error) return res.status(500).json({ error: error.message });

    // Audit
    await supabase.from('enterprise_audit').insert({
      license_id: license.id,
      event_type: 'USAGE_REPORT',
      detail: { total_tokens, request_count, period_start, period_end },
      actor: 'agent',
      ip_address: req.ip,
    });

    return res.json({ ok: true, received_tokens: total_tokens });
  });

  /** GET /api/enterprise/updates/check — Agent checks for updates */
  app.get('/api/enterprise/updates/check', async (req, res) => {
    const { license_key, current_version } = req.query;

    const check = await validateAgentLicense(supabase, license_key, req);
    if (!check.valid) return res.status(check.status).json({ error: check.error });
    const license = check.license;

    // Get latest current release
    const { data: latest } = await supabase
      .from('enterprise_releases')
      .select('*')
      .eq('is_current', true)
      .maybeSingle();

    if (!latest || latest.version === current_version) {
      return res.json({ update_available: false, current_version });
    }

    return res.json({
      update_available: true,
      current_version,
      new_version: latest.version,
      release_type: latest.release_type,
      changelog: latest.changelog,
      download_url: latest.download_url,
      checksum_sha256: latest.checksum_sha256,
      size_mb: latest.size_mb,
    });
  });

  // ════════════════════════════════════════════════════════════
  //  ADMIN QUERY ENDPOINTS
  // ════════════════════════════════════════════════════════════

  /** GET /api/enterprise/deployments — All deployments */
  app.get('/api/enterprise/deployments', requireAdmin, async (req, res) => {
    const { data, error } = await supabase
      .from('enterprise_deployments')
      .select('*, enterprise_licenses(client_name, license_key, expires_at, is_active)')
      .order('last_heartbeat', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });

    // Mark offline if no heartbeat in 2 hours
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const enriched = (data || []).map(d => ({
      ...d,
      status: d.status === 'air-gapped' ? 'air-gapped'
        : (d.last_heartbeat && new Date(d.last_heartbeat) < twoHoursAgo) ? 'offline'
        : d.status,
    }));

    return res.json({ deployments: enriched });
  });

  /** GET /api/enterprise/usage — Usage history for a license */
  app.get('/api/enterprise/usage', requireAdmin, async (req, res) => {
    const { license_id, months = 3 } = req.query;
    const since = new Date();
    since.setMonth(since.getMonth() - parseInt(months));

    let query = supabase
      .from('enterprise_usage')
      .select('*, enterprise_licenses(client_name)')
      .gte('period_start', since.toISOString())
      .order('period_start', { ascending: false })
      .limit(500);

    if (license_id) query = query.eq('license_id', license_id);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    return res.json({ usage: data });
  });

  /** GET /api/enterprise/usage/summary — Monthly summary */
  app.get('/api/enterprise/usage/summary', requireAdmin, async (req, res) => {
    const year = parseInt(req.query.year || new Date().getFullYear());
    const month = parseInt(req.query.month || (new Date().getMonth() + 1));

    const { data, error } = await supabase.rpc('enterprise_monthly_summary', {
      p_year: year,
      p_month: month,
    });
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ summary: data, period: `${year}-${String(month).padStart(2, '0')}` });
  });

  /** GET /api/enterprise/audit — Audit log query */
  app.get('/api/enterprise/audit', requireAdmin, async (req, res) => {
    const { license_id, event_type, limit: lim = 100, offset = 0 } = req.query;
    const limitN = Math.min(parseInt(lim), 500);
    const offsetN = parseInt(offset) || 0;

    let query = supabase
      .from('enterprise_audit')
      .select('*, enterprise_licenses(client_name)', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offsetN, offsetN + limitN - 1);

    if (license_id) query = query.eq('license_id', license_id);
    if (event_type) query = query.eq('event_type', event_type);

    const { data, count, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    return res.json({ events: data, total: count });
  });

  /** POST /api/enterprise/releases — Publish new release */
  app.post('/api/enterprise/releases', requireAdmin, async (req, res) => {
    const { version, release_type, changelog, download_url,
            checksum_sha256, size_mb, engine_version, minilm_version, set_current } = req.body;

    if (!version) return res.status(400).json({ error: 'version required.' });

    // If set_current, unmark all others
    if (set_current) {
      await supabase.from('enterprise_releases').update({ is_current: false }).eq('is_current', true);
    }

    const { data, error } = await supabase.from('enterprise_releases').upsert({
      version,
      release_type: release_type || 'patch',
      changelog: changelog || '',
      download_url: download_url || null,
      checksum_sha256: checksum_sha256 || null,
      size_mb: size_mb || null,
      engine_version: engine_version || null,
      minilm_version: minilm_version || null,
      is_current: !!set_current,
    }, { onConflict: 'version' }).select().single();

    if (error) return res.status(500).json({ error: error.message });

    // Audit
    await supabase.from('enterprise_audit').insert({
      event_type: 'RELEASE_PUBLISH',
      detail: { version, release_type, set_current },
      actor: 'admin',
    });

    return res.status(201).json({ release: data });
  });

  /** GET /api/enterprise/releases — List releases */
  app.get('/api/enterprise/releases', requireAdmin, async (req, res) => {
    const { data, error } = await supabase
      .from('enterprise_releases')
      .select('*')
      .order('published_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });

    // Enrich with deployment count per version
    const { data: deps } = await supabase
      .from('enterprise_deployments')
      .select('engine_version');
    const versionCounts = {};
    for (const d of (deps || [])) {
      if (d.engine_version) versionCounts[d.engine_version] = (versionCounts[d.engine_version] || 0) + 1;
    }
    const releases = (data || []).map(r => ({
      ...r,
      deployed_count: versionCounts[r.engine_version] || 0,
    }));

    return res.json({ releases });
  });

  /**
   * POST /api/enterprise/updates/push — Push update to specific clients
   * Body: { version, target_license_ids: [...] | "all", schedule_at? }
   *
   * This doesn't directly push to agents (agents pull on their schedule).
   * Instead, it creates a targeted update record that the agent's /updates/check
   * will pick up. For immediate push, agent check interval should be short.
   */
  app.post('/api/enterprise/updates/push', requireAdmin, async (req, res) => {
    const { version, target_license_ids, schedule_at } = req.body;
    if (!version) return res.status(400).json({ error: 'version required.' });

    // Verify version exists
    const { data: release } = await supabase
      .from('enterprise_releases')
      .select('*')
      .eq('version', version)
      .maybeSingle();
    if (!release) return res.status(404).json({ error: `Version ${version} not found.` });

    // Mark this version as current (agents will pick it up on next check)
    await supabase.from('enterprise_releases').update({ is_current: false }).eq('is_current', true);
    await supabase.from('enterprise_releases').update({ is_current: true }).eq('version', version);

    // Audit for each target
    const targets = target_license_ids === 'all' ? ['all'] : (target_license_ids || []);
    for (const t of targets) {
      await supabase.from('enterprise_audit').insert({
        license_id: t === 'all' ? null : t,
        event_type: 'UPDATE_PUSH',
        detail: { version, target: t, schedule_at: schedule_at || 'immediate' },
        actor: 'admin',
      });
    }

    console.log(`[enterprise] update pushed: v${version} → ${targets.length} target(s)`);
    return res.json({
      ok: true,
      version,
      targets: targets.length,
      message: `Version ${version} set as current. Agents will pick up on next check cycle.`,
    });
  });

  /**
   * POST /api/enterprise/updates/rollback — Force rollback a client to previous version
   * Body: { license_id, to_version }
   *
   * This records a rollback intent. The agent picks it up via a special field
   * in the /updates/check response.
   */
  app.post('/api/enterprise/updates/rollback', requireAdmin, async (req, res) => {
    const { license_id, to_version } = req.body;
    if (!license_id || !to_version) return res.status(400).json({ error: 'license_id and to_version required.' });

    // Verify target version exists
    const { data: release } = await supabase
      .from('enterprise_releases')
      .select('version')
      .eq('version', to_version)
      .maybeSingle();
    if (!release) return res.status(404).json({ error: `Version ${to_version} not found.` });

    // Store rollback intent in deployment metadata
    await supabase.from('enterprise_deployments')
      .update({
        metadata: { rollback_to: to_version, rollback_requested_at: new Date().toISOString() },
        updated_at: new Date().toISOString(),
      })
      .eq('license_id', license_id);

    // Audit
    await supabase.from('enterprise_audit').insert({
      license_id,
      event_type: 'UPDATE_ROLLBACK',
      detail: { to_version },
      actor: 'admin',
    });

    console.log(`[enterprise] rollback requested: license ${license_id.slice(0,8)} → v${to_version}`);
    return res.json({ ok: true, to_version, message: 'Rollback queued. Agent will apply on next check.' });
  });

  console.log('[enterprise] API routes registered');
}
