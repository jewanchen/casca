# Casca — Zapier Integration

**Cut your AI costs by 60-90%. Connect Casca to 8,000+ apps via Zapier.**

Casca is an AI routing engine that classifies every prompt and routes it to the cheapest model that can handle it. This Zapier integration lets you use Casca AI in any automation workflow — no coding required.

## What You Can Do

| Trigger / Action | Description |
|-----------------|-------------|
| **AI Chat** | Send any prompt → get AI response (auto-routed to best model) |
| **Summarize Text** | Condense emails, tickets, docs into bullet points |
| **Translate Text** | Translate to 13 languages |
| **Generate SOQL** | Natural language → Salesforce query |
| **New API Request** (trigger) | Fire when a new AI request is processed |
| **New Annotation** (trigger) | Fire when a prompt needs human review |
| **Usage Alert** (trigger) | Fire when token quota exceeds 80% |
| **Find Usage Stats** (search) | Look up current plan, balance, tokens |

## Quick Start

### 1. Get Your API Key
Sign up at [cascaio.com/dashboard](https://cascaio.com/dashboard) and create an API key (starts with `csk_`).

### 2. Connect in Zapier
1. Create a new Zap
2. Search for **"Casca"** in the app list
3. Enter your API key when prompted
4. Choose a trigger or action and configure it

### 3. Example Zaps

**Email → AI Summary → Slack:**
```
Gmail (New Email) → Casca (Summarize) → Slack (Send Message)
```

**Salesforce Case → AI Analysis → Slack:**
```
Salesforce (New Case) → Casca (AI Chat) → Slack (Post)
```

**Usage Alert → Email:**
```
Casca (Usage Alert) → Gmail (Send Email)
```

## For Developers

This integration is built with [Zapier Platform CLI](https://github.com/zapier/zapier-platform).

### Project Structure
```
casca-zapier/
├── index.js              — Main integration definition
├── authentication.js     — API Key auth (csk_...)
├── triggers/
│   ├── newApiLog.js      — Polling: new API requests
│   ├── newAnnotation.js  — Polling: new annotations
│   └── usageAlert.js     — Polling: quota warning
├── actions/
│   ├── aiChat.js         — AI Chat (general purpose)
│   ├── summarize.js      — Summarize text
│   ├── translate.js      — Translate text
│   └── generateSoql.js   — Natural language → SOQL
├── searches/
│   └── findUsage.js      — Account usage lookup
├── test/
│   └── basic.test.js     — Structure tests
├── ZAP_TEMPLATES.md      — 10 pre-built Zap templates
└── package.json
```

### Local Development
```bash
npm install
npx zapier login
npx zapier register "Casca AI Router"
npx zapier push
npx zapier test
```

### API Endpoints Used
| Endpoint | Method | Used By |
|----------|--------|---------|
| `/api/zapier/auth-test` | GET | Authentication test |
| `/api/zapier/logs` | GET | New API Log trigger |
| `/api/zapier/annotations` | GET | New Annotation trigger |
| `/api/zapier/usage` | GET | Usage Alert trigger |
| `/api/zapier/chat` | POST | AI Chat action |
| `/api/zapier/summarize` | POST | Summarize action |
| `/api/zapier/translate` | POST | Translate action |
| `/api/zapier/generate-soql` | POST | Generate SOQL action |
| `/api/dashboard/me` | GET | Find Usage search |

## Publishing Checklist

- [ ] Register integration: `npx zapier register`
- [ ] Push code: `npx zapier push`
- [ ] Test all triggers and actions in Zap Editor
- [ ] Share with 5+ beta users
- [ ] Submit for review (Zapier reviews in ≤1 week)
- [ ] Create 10 Zap templates (see ZAP_TEMPLATES.md)
- [ ] Reach 50 active users during 90-day beta
- [ ] Auto-promoted to Public after requirements met

## Support

- Docs: [cascaio.com/docs/salesforce](https://cascaio.com/docs/salesforce)
- Email: support@cascaio.com
- Issues: [github.com/jewanchen/casca-zapier/issues](https://github.com/jewanchen/casca-zapier/issues)

## License

MIT
