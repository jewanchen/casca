#!/bin/bash
# ══════════════════════════════════════════════════════════════
# Generate RSA key pair for offline license signing
#
# Private key: kept on Casca Cloud (NEVER shared with clients)
# Public key:  embedded in the compiled binary / agent
# ══════════════════════════════════════════════════════════════

KEYDIR="$(cd "$(dirname "$0")" && pwd)"

echo "Generating RSA-4096 key pair for license signing..."

# Private key (keep secret!)
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 \
  -out "$KEYDIR/license-private.pem" 2>/dev/null

# Public key (embed in binary)
openssl pkey -in "$KEYDIR/license-private.pem" -pubout \
  -out "$KEYDIR/license-public.pem"

# Verify
echo ""
echo "✓ Private key: $KEYDIR/license-private.pem (KEEP SECRET)"
echo "✓ Public key:  $KEYDIR/license-public.pem (embed in binary)"
echo ""
echo "⚠ Add license-private.pem to .gitignore!"
echo "⚠ Store private key in Casca Cloud env var: LICENSE_SIGNING_KEY"
