# Casca Enterprise — On-Premise Deployment Guide

## Quick Start (5 minutes)

### Prerequisites
- Docker + Docker Compose
- License key from Casca (contact sales@cascaio.com)

### Deploy

```bash
# 1. Copy environment file
cp .env.example .env

# 2. Edit .env — add your license key
nano .env   # Set CASCA_LICENSE_KEY=ent_xxxxx

# 3. Start all services
docker compose -f docker-compose.enterprise.yml up -d

# 4. Verify
curl http://localhost:3001/health
```

### Test

```bash
# Route a request (replace sk-xxx with your OpenAI key)
curl -X POST http://localhost:3001/api/v1/chat/completions \
  -H "Authorization: Bearer sk-xxx" \
  -H "X-Casca-Key: csk_xxx" \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role": "user", "content": "What is an API?"}]}'
```

## Architecture

```
┌─────────────────────────────────────────────┐
│  Your Server                                 │
│                                              │
│  ┌──────────────┐  ┌────────────────────┐   │
│  │ casca-engine  │  │ casca-minilm       │   │
│  │ (compiled     │  │ (L2 classifier)    │   │
│  │  binary)      │→ │ localhost:8000     │   │
│  │ :3001         │  └────────────────────┘   │
│  └──────┬───────┘                            │
│         │         ┌────────────────────┐     │
│         │         │ casca-agent        │     │
│         │         │ (license + usage   │──→ Cloud
│         │         │  + updates)        │     │
│         │         └────────────────────┘     │
│         │         ┌────────────────────┐     │
│         └────────→│ PostgreSQL (local) │     │
│                   └────────────────────┘     │
└─────────────────────────────────────────────┘
```

## Services

| Service | Port | Description |
|---------|------|-------------|
| casca-engine | 3001 | API gateway + L1 classifier (compiled binary) |
| casca-minilm | 8000 (internal) | L2 MiniLM inference |
| casca-agent | — (background) | License, usage reporting, updates |
| db | 5432 (internal) | Local PostgreSQL |

## Configuration

See `.env.example` for all options.

## Air-Gapped Deployment

For environments without internet access:

1. Request offline license from Casca admin
2. Place `license.json` in the agent directory
3. Set `CASCA_CLOUD_URL=` (empty) in `.env`
4. Updates must be applied manually (download offline package)

## Support

- Email: support@cascaio.com
- Documentation: https://cascaio.com/docs/enterprise
