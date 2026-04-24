# Casca Enterprise — Security Specification

## 1. Code Protection

### Binary Compilation
- **Tool**: `@yao-pkg/pkg` (Node.js → V8 bytecode snapshot)
- **Additional layer**: `javascript-obfuscator` on `casca-classifier.cjs`
  - Control flow flattening
  - Dead code injection
  - String array encoding
- **Future**: Rewrite classifier core in Go/Rust → compile to `.so` shared library

### Docker Image Security
- Multi-stage build: source code only in build stage
- Production image: only compiled binary + dependencies
- No `.js` source files in production image
- `docker history` shows no sensitive layers

## 2. License Security

### Online License (phone-home)
```
Agent → HTTPS → Casca Cloud /api/enterprise/licenses/validate
  Request:  { license_key, machine_id }
  Response: { valid, expires_at, features }
```
- HTTPS (TLS 1.3)
- License key: `ent_` + 32 hex chars (128-bit entropy)
- Machine ID: SHA-256 of hostname + CPU model + MAC + total RAM

### Offline License (air-gapped)
```json
{
  "data": {
    "license_key": "ent_xxx",
    "client_name": "...",
    "machine_id": "sha256_hash",
    "features": ["L1", "L2", "cache"],
    "token_limit_monthly": 500000000,
    "expires_at": "2027-04-24T00:00:00Z",
    "issued_at": "2026-04-24T00:00:00Z",
    "issuer": "casca-cloud",
    "version": 1
  },
  "signature": "RSA-SHA256 signature of JSON.stringify(data)"
}
```

**Signing**: RSA-4096 private key (kept on Casca Cloud)
**Verification**: RSA public key (embedded in compiled binary)
**Tampering**: Modifying any field invalidates the signature

### Machine Binding
- Optional: license can be bound to specific machine_id
- Machine ID derived from hardware fingerprint (non-spoofable)
- If machine changes: client requests new license from admin

### Grace Period
- Default: 7 days
- When Cloud unreachable: Agent uses cached last-valid-check
- After grace period: engine stops accepting requests
- Returns 503 with message "License validation required"

## 3. Communication Security

### Agent ↔ Cloud
- **Current**: HTTPS (TLS 1.3)
- **Future**: mTLS (mutual TLS)
  - Agent has client certificate (issued at license creation)
  - Cloud validates certificate belongs to known agent
  - Prevents: man-in-the-middle, unauthorized agents

### mTLS Implementation (Future)
```
Certificate chain:
  Casca Root CA (self-signed, kept offline)
    └── Agent Certificate (per-client, issued at license creation)
         CN = ent_xxx (license key)
         Validity = license duration

Agent config:
  CASCA_CLIENT_CERT=/app/certs/agent.pem
  CASCA_CLIENT_KEY=/app/certs/agent-key.pem
  CASCA_CA_CERT=/app/certs/casca-ca.pem

Cloud nginx:
  ssl_client_certificate /etc/nginx/casca-ca.pem;
  ssl_verify_client on;
```

## 4. Data Sovereignty

### What Agent sends to Cloud
```
ONLY aggregated metrics:
  ✅ total_tokens: 2450000
  ✅ request_count: 1823
  ✅ breakdown: { HIGH: 274, MED: 912, LOW: 637 }
  ✅ engine_version: "3.3.0"
  ✅ uptime_s: 86400

NEVER sent:
  ❌ Prompt text (raw or masked)
  ❌ LLM responses
  ❌ Client's API keys
  ❌ Any PII
  ❌ Any business data
```

### Audit Trail
- Agent reports payload schema is public and auditable
- Clients can enable `USAGE_REPORT_DRY_RUN=true` to see exactly what would be sent
- Contract clause: "Casca only collects aggregated usage metrics"

## 5. Binary Integrity

### Code Signing (Future)
```
Build pipeline:
  1. Compile binary
  2. Sign with Casca signing key: sha256sum casca-engine > casca-engine.sha256
  3. Sign the hash: openssl dgst -sha256 -sign private.pem casca-engine.sha256 > casca-engine.sig

Agent verification at startup:
  1. Read casca-engine.sig
  2. Verify with embedded public key
  3. If mismatch → refuse to start (binary tampered)
```

### Per-Client Versioning
- Each enterprise build can include a unique watermark
- If binary leaks, watermark traces back to which client leaked it
- Implementation: embed `client_id` hash in a dead-code section of the binary

## 6. Revocation

### Immediate Revocation
- Admin clicks "Revoke" in dashboard
- Sets `is_active = false` in enterprise_licenses
- Next Agent phone-home → receives `valid: false` → engine stops
- Grace period does NOT apply to explicit revocation

### Key Rotation
- If license key compromised: revoke old, generate new
- If signing key compromised: rotate RSA key pair, re-issue all offline licenses

## 7. Compliance Readiness

| Standard | Status | Notes |
|----------|--------|-------|
| SOC 2 Type II | In progress | Target Q3 2026 |
| ISO 27001 | Planned | Post-SOC 2 |
| GDPR | Compliant | No EU PII stored |
| PDPA (TH) | Compliant | No TH PII stored |
| PIPL (CN) | Compliant | No CN PII stored |

## 8. Incident Response

### If binary is leaked
1. Identify client via watermark
2. Revoke their license immediately
3. Rotate all affected keys
4. Issue new binary version with updated security

### If license key is compromised
1. Revoke compromised key
2. Generate new key for legitimate client
3. Audit log: check for unauthorized usage

### If signing key is compromised
1. Generate new RSA key pair
2. Re-issue all offline licenses
3. Push binary update with new public key embedded
