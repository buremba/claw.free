# Telegram Bot Onboarding System - Implementation Plan

## Decisions Log

| Question | Decision | Rationale |
|----------|----------|-----------|
| Master bot isolation | Restrict shell to onboarding scripts only | Multiple strangers use the bot; no freeform shell |
| User VM OS | Debian/Ubuntu | Hackable, easy to customize, apt package manager |
| Custom skills | Via bot conversation + curated marketplace | Users say "install this skill" or browse a registry |
| SSH repair access | User explicitly confirms in chat | Mode A = we already have access; confirmation is UX, not technical |
| Bot discovery | t.me bot link only | No phone number needed |
| GCP mode | Mode A (we provide GCP) for MVP | Generic interface, implement only platform-provided for now |
| Authentication | Telegram identity via Mini App `initData` | No Google OAuth needed for MVP; Telegram IS the identity |
| Token input | Via Mini App (never in chat) | Tokens in chat history feel insecure; Mini App = HTTPS direct to API |
| Security bugs | Fix critical ones now | Rate limiting, token encryption, input validation |

---

## Overview

Deploy an **OpenClaw instance** on Railway as the master onboarding bot. The bot handles the conversational parts (greeting, provider selection, progress updates, support). A **Telegram Mini App** handles sensitive inputs (bot token) and serves as the user dashboard (list bots, manage skills, view status).

No Google OAuth needed. Mode A uses our platform GCP, and Telegram `initData` provides cryptographically verified user identity. No grammY or custom bot frameworks - just OpenClaw + a skill + a React Mini App.

---

## Architecture

```
Railway (our infra)
├── OpenClaw Gateway (master Telegram bot, restricted shell)
├── Hono API Server (existing, extended with deploy + Mini App endpoints)
├── Mini App (React, served by Hono, opened inside Telegram)
├── PostgreSQL (users, deployments, bot registry)
└── Platform GCP Service Account (deploys user VMs in our project)

Platform GCP Project (our infra, Mode A)
└── Per-user Debian/Ubuntu VMs
    ├── OpenClaw gateway (user's Telegram bot)
    ├── Bootstrap provider (LLM auth flow)
    └── User workspace (skills, files, customizations)
```

---

## How It Works

```
1. User visits website → clicks "Open in Telegram" → t.me/ClawFreeBot
2. User sends /start
3. Bot greets them, explains the service
4. Bot asks: "Which AI provider do you want? Claude, ChatGPT, or Kimi?"
5. Bot says: "Great! Tap the button below to set up your bot."
   → sends inline keyboard button that opens Mini App
6. Mini App opens inside Telegram:
   a. Validates initData (verified Telegram user ID)
   b. Shows "Create a bot" step - links to @BotFather instructions
   c. User pastes token in Mini App form (never in chat)
   d. Mini App calls API → validates token (getMe + setWebhook)
   e. Mini App shows "Deploy" button → triggers deployment
   f. Mini App shows real-time deployment progress
   g. Deployment complete → Mini App shows success + link to new bot
7. Bot also receives deployment events, sends chat message:
   "Your bot @YourBotName is live! Go talk to it."
8. User returns to Mini App anytime to see their bots dashboard
```

---

## Identity Model

No Google OAuth needed. Each messaging channel provides native verified identity:

```
Telegram  → initData (signed by Telegram, contains user ID, name, photo)
WhatsApp  → phone number (verified by WhatsApp, via Flows callback)
Discord   → Discord user ID (via interaction tokens)
Web       → Google OAuth (only channel that needs it, for direct web access)
```

### User Table

```sql
CREATE TABLE "user" (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE channel_identity (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES "user"(id),
  channel_type TEXT NOT NULL,          -- 'telegram', 'whatsapp', 'discord', 'google'
  channel_user_id TEXT NOT NULL,       -- telegram user ID, phone number, etc.
  display_name TEXT,
  avatar_url TEXT,
  raw_data JSONB,                      -- full initData or profile payload
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(channel_type, channel_user_id)
);

CREATE TABLE deployment (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES "user"(id),
  bot_token_encrypted TEXT NOT NULL,
  bot_username TEXT,
  llm_provider TEXT NOT NULL,          -- 'claude', 'openai', 'kimi'
  cloud_provider TEXT DEFAULT 'gcp',
  vm_name TEXT,
  vm_zone TEXT,
  vm_ip TEXT,
  status TEXT DEFAULT 'pending',       -- pending, creating, booting, running, error, stopped
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

This replaces the current in-memory deploy store with persistent tracking, and replaces Google-specific user/account tables with channel-agnostic identity.

---

## Telegram Mini App

The Mini App is a React SPA served by our Hono server, opened as a WebApp inside Telegram.

### Setup

Register the Mini App URL with BotFather:
```
/setmenubutton → Web App URL: https://claw-free.up.railway.app/mini
```

Bot sends it via inline keyboard:
```json
{
  "reply_markup": {
    "inline_keyboard": [[{
      "text": "Set up your bot",
      "web_app": { "url": "https://claw-free.up.railway.app/mini" }
    }]]
  }
}
```

### initData Validation

Telegram signs `initData` with the bot token using HMAC-SHA256. Server validates:

```typescript
import { createHmac } from 'crypto';

function validateInitData(initData: string, botToken: string): TelegramUser | null {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  params.delete('hash');

  // Sort and join params
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  // HMAC chain: secret = HMAC-SHA256("WebAppData", botToken), then HMAC-SHA256(secret, data)
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computedHash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (computedHash !== hash) return null;

  const user = JSON.parse(params.get('user') || '{}');
  return user; // { id, first_name, last_name, username, photo_url, ... }
}
```

### Mini App Pages

**Dashboard** (`/mini`):
- List of user's deployed bots (name, status, uptime)
- "Create new bot" button
- Quick actions per bot: view logs, restart, manage skills

**Create Bot** (`/mini/create`):
- Step 1: Instructions to create bot via @BotFather + paste token
- Step 2: Token validation feedback (bot name, username shown)
- Step 3: Confirm LLM provider (pre-selected from chat conversation)
- Step 4: Deploy button → shows progress bar
- Step 5: Success screen with link to new bot

**Bot Detail** (`/mini/bot/:id`):
- Status, uptime, VM IP
- Logs viewer (recent journalctl output via API)
- Installed skills list
- "Install skill" button (browse marketplace or paste URL)
- "Restart" button
- "Grant repair access" toggle

### Cross-Channel Pattern

The Mini App UI is the same React code. Only the identity layer differs:

```
/mini              → Telegram Mini App (initData auth)
/mini?wa=<token>   → WhatsApp Flows (WhatsApp signed payload auth)
/app               → Web standalone (Google OAuth auth, future)
```

Same React components, same API endpoints. Just different auth wrappers.

---

## Security Hardening (Fix Now)

### 1. Rate Limiting
- Per-IP: 60 req/min general, 10 req/min for deploy endpoints
- Per-user: 1 deploy per 10 minutes
- Mini App API: 30 req/min per Telegram user ID

### 2. Token Encryption at Rest
- Encrypt bot tokens using AES-256-GCM before storing in `deployment.bot_token_encrypted`
- Derive key from `ENCRYPTION_KEY` env var
- Never log tokens in plaintext

### 3. Input Validation
- Bot token format: `/^\d+:[A-Za-z0-9_-]{35}$/`
- Sanitize all user input in deploy parameters
- Validate GCP zones against allowlist

### 4. initData Expiry
- Reject `initData` older than 5 minutes (check `auth_date` field)
- Prevents replay attacks with stolen initData

---

## Master Bot Shell Restriction

The master bot's skill restricts shell to a command dispatcher:

```bash
#!/bin/bash
# scripts/run.sh - only entry point the AI calls
set -euo pipefail
ALLOWED="validate-token|deploy-bot|deploy-status|send-first-message|diagnose-vm"
SCRIPT="$1"; shift
if [[ "$SCRIPT" =~ ^($ALLOWED)$ ]]; then
  exec bash "$(dirname "$0")/${SCRIPT}.sh" "$@"
else
  echo "ERROR: Unknown command: $SCRIPT" >&2
  exit 1
fi
```

Note: `create-oauth-link` and `check-oauth` are gone. Token input happens in Mini App, not via bot scripts. The bot's scripts are now:

| Script | Purpose |
|--------|---------|
| `validate-token.sh` | Verify token via getMe (called by Mini App API, not bot directly) |
| `deploy-bot.sh` | Trigger deployment via API |
| `deploy-status.sh` | Poll deployment progress |
| `send-first-message.sh` | Send welcome message from user's new bot |
| `diagnose-vm.sh` | SSH into user VM for repair (with permission) |

The token validation actually moves to the API layer (called by Mini App). The bot mainly uses `deploy-status` and `send-first-message`.

---

## Bot Token Verification

Token is entered in the Mini App, validated server-side:

1. **Format check**: regex validation
2. **`getMe`**: proves token is real, gets bot username + ID
3. **`setWebhook`**: sets our temporary webhook URL, proves token has control
4. **`deleteWebhook`** on deployment: real webhook set by OpenClaw on the VM

Token never appears in Telegram chat history.

---

## Cloud Provider Abstraction

Generic interface, only GCP Mode A implemented:

```typescript
interface CloudProvider {
  name: string;
  createVM(config: VMConfig): Promise<{ deploymentId: string }>;
  getVMStatus(deploymentId: string): Promise<VMStatus>;
  deleteVM(deploymentId: string): Promise<void>;
  execOnVM(deploymentId: string, command: string): Promise<string>; // for diagnostics
}

interface VMConfig {
  botToken: string;
  llmProvider: 'claude' | 'openai' | 'kimi';
  botName: string;
  userId: string;
}

type VMStatus = {
  state: 'creating' | 'booting' | 'running' | 'error' | 'stopped';
  ip?: string;
  setupProgress?: string;
  error?: string;
};
```

MVP implementation: `GCPPlatformProvider` using platform service account.

---

## User VM: Debian/Ubuntu

### Base Image
- Debian 12 (Bookworm) or Ubuntu 24.04 LTS
- Pre-installed: OpenClaw CLI, Node.js 22, curl, git
- Pre-installed CLI tools: claude, codex, gemini
- Startup script from GCP metadata
- Systemd services for openclaw-gateway and claw-free-provider

### Migration from NixOS
1. Build Debian/Ubuntu image with Packer (or GCE image builder)
2. Bash startup script replaces NixOS module system
3. Same metadata interface (TELEGRAM_TOKEN, LLM_PROVIDER, BOT_NAME)
4. Same guest attributes for progress reporting

---

## Server-Side Changes (Hono API)

### New Endpoints

**Mini App Auth:**
- `POST /api/mini/auth` - Validate `initData`, return JWT session token
  - Validates HMAC signature against bot token
  - Checks `auth_date` not older than 5 minutes
  - Finds or creates user + channel_identity
  - Returns short-lived JWT for subsequent API calls

**Mini App Operations:**
- `GET /api/mini/bots` - List user's deployed bots
- `POST /api/mini/bots` - Create new bot (validate token + deploy)
- `GET /api/mini/bots/:id` - Bot detail (status, IP, logs)
- `POST /api/mini/bots/:id/restart` - Restart bot's VM services
- `DELETE /api/mini/bots/:id` - Stop and delete bot
- `POST /api/mini/bots/:id/repair` - Grant repair access

**Token Validation (called by Mini App):**
- `POST /api/mini/validate-token` - Validate bot token (getMe + setWebhook)

**Deploy API (called by skill scripts):**
- `POST /api/deploy/start` - Internal, X-Internal-Key auth, Mode A
- `GET /api/deploy/:id` - Poll status (existing, add internal auth option)

### Removed (from previous plan)
- ~~`POST /api/auth/telegram-bridge`~~ - Not needed, Mini App replaces this
- ~~`GET /api/auth/telegram-bridge/:state`~~ - Not needed
- ~~Modified `auth-google.ts`~~ - Not needed for MVP

---

## Environment Variables

```env
# Required
TELEGRAM_BOT_TOKEN=        # Master bot's Telegram token
ANTHROPIC_API_KEY=         # AI model for the onboarding conversation
DATABASE_URL=              # PostgreSQL
BASE_URL=                  # Public URL (e.g., https://claw-free.up.railway.app)
INTERNAL_API_KEY=          # For skill scripts → API auth
ENCRYPTION_KEY=            # AES-256 key for encrypting tokens at rest

# Mode A - Platform GCP (required for MVP)
GCP_SERVICE_ACCOUNT_KEY=   # Platform GCP service account JSON
GCP_PROJECT_ID=            # Platform GCP project

# Removed from MVP (not needed without Google OAuth)
# GOOGLE_CLIENT_ID=
# GOOGLE_CLIENT_SECRET=
```

---

## Onboarding Skill (Master Bot)

```markdown
---
name: claw.free-onboarding
description: Help users set up their own AI Telegram bot
tools:
  - shell
---

You are the claw.free onboarding assistant. Guide users through creating
their own AI-powered Telegram bot.

## Conversation Flow

1. Greet the user, explain what claw.free does (free AI bot in 2 minutes)
2. Ask which AI provider they want (Claude, ChatGPT, or Kimi)
3. Send them to the Mini App to complete setup:
   - "Tap the button below to set up your bot"
   - Send inline keyboard with Mini App button
4. Monitor deployment progress: `bash scripts/run.sh deploy-status <id>`
5. When complete, confirm in chat: "Your bot @BotName is live!"
6. Send first message: `bash scripts/run.sh send-first-message <token> <user_id>`

## Support Flow

If a user says their bot is broken:
1. Ask for permission to diagnose: "Can I connect to check what's wrong?"
2. On confirmation: `bash scripts/run.sh diagnose-vm <deployment_id>`
3. Report findings and offer fixes

## Important
- ONLY execute commands through `scripts/run.sh`
- Never ask for bot tokens in chat - always direct to Mini App
- Show deployment progress updates
- After deployment, confirm the user's bot is responding
```

---

## Deployment on Railway

```json
{
  "deploy": {
    "startCommand": "npm run start & openclaw gateway --port 18789",
    "healthcheckPath": "/healthz"
  }
}
```

Mini App is served by the same Hono server at `/mini/*`.

---

## Custom Skills

### Via Bot Conversation (Phase 2)
User tells their bot: "Install the weather skill"
- Bot downloads skill from registry or git URL
- Adds to OpenClaw config, restarts gateway

### Curated Marketplace (Phase 3)
- Browsable in Mini App dashboard
- One-click install from Mini App
- Skills reviewed for safety

---

## SSH Repair / VM Diagnostics

Since Mode A = we own the infrastructure, we already have access. The "user grants permission" is a conversational confirmation, not a technical grant.

**diagnose-vm.sh:**
```bash
#!/bin/bash
set -euo pipefail
DEPLOYMENT_ID="$1"
# Fetch VM details from API
VM_INFO=$(curl -s "${BASE_URL}/api/deploy/${DEPLOYMENT_ID}" \
  -H "X-Internal-Key: ${INTERNAL_API_KEY}")
VM_NAME=$(echo "$VM_INFO" | jq -r '.vmName')
VM_ZONE=$(echo "$VM_INFO" | jq -r '.zone')

# Run diagnostic commands via gcloud
gcloud compute ssh "$VM_NAME" --zone="$VM_ZONE" --tunnel-through-iap \
  --command="systemctl status openclaw-gateway; journalctl -u openclaw-gateway --no-pager -n 50; df -h; free -h"
```

---

## Sandbox Hardening (User VMs, Phase 2)

**Network allowlist** - iptables:
- Allow: api.anthropic.com, api.openai.com, api.moonshot.cn, api.telegram.org, metadata.google.internal
- Allow: DNS, loopback, GCP IAP range
- Block: everything else

**Filesystem**: writable dirs only for `/var/lib/openclaw`, `/tmp`, `/var/log`, `/home/openclaw`

---

## Website Changes (Phase 2)

Simple landing page:
- Hero: "Get your own AI assistant in 2 minutes"
- Primary CTA: **"Open in Telegram"** → `t.me/ClawFreeBot`
- Secondary: existing wizard for power users

---

## Implementation Order

| # | What | Description |
|---|------|-------------|
| 0 | Security fixes | Rate limiting, token encryption, input validation |
| 1 | DB schema update | channel_identity + deployment tables, migrate from in-memory store |
| 2 | Cloud provider abstraction | Generic interface + GCP Mode A implementation |
| 3 | Debian/Ubuntu VM image | Replace NixOS, bash startup script |
| 4 | Mini App: initData auth | Validate Telegram initData, issue JWT |
| 5 | Mini App: create bot flow | Token input, validation, deploy trigger, progress |
| 6 | Mini App: dashboard | List bots, status, quick actions |
| 7 | OpenClaw on Railway | Master bot gateway with onboarding skill |
| 8 | Onboarding skill | SKILL.md + restricted scripts + run.sh |
| 9 | End-to-end flow | Bot conversation → Mini App → deploy → first message |
| 10 | SSH repair / diagnostics | diagnose-vm.sh + user permission flow |
| 11 | Sandbox hardening | Network allowlist + filesystem restrictions |
| 12 | Website update | Landing page with Telegram CTA |
| 13 | Custom skills via conversation | Install skills by talking to your bot |
| 14 | Skill marketplace | Curated registry in Mini App dashboard |

**Phase 1 (MVP): Steps 0-9** - Security + Mini App + working end-to-end onboarding.
**Phase 2: Steps 10-12** - Repair, sandbox, website.
**Phase 3: Steps 13-14** - Custom skills + marketplace.
**Phase 4: WhatsApp + more channels** - Same Mini App, different auth wrappers.
**Phase 5: Whitelabel** - Reseller support with multi-tenant master bots.

---

## Whitelabel (Phase 5)

Reseller config stored in DB:
```sql
CREATE TABLE reseller (
  id UUID PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  master_bot_token_encrypted TEXT NOT NULL,
  system_prompt_override TEXT,
  cloud_provider TEXT DEFAULT 'gcp',
  cloud_credentials_encrypted TEXT,
  cloud_project_id TEXT,
  default_provider TEXT DEFAULT 'claude',
  max_deployments INT DEFAULT 100,
  mini_app_theme JSONB,               -- Custom colors, logo, branding
  owner_user_id UUID REFERENCES "user"(id),
  created_at TIMESTAMPTZ DEFAULT now()
);
```

---

## Why This Approach

- **No OAuth needed**: Telegram identity is sufficient for Mode A. Removes entire auth complexity.
- **Token never in chat**: Mini App handles sensitive inputs via HTTPS. Users feel secure.
- **Cross-channel ready**: Same Mini App UI works for WhatsApp Flows, Discord, web. Only auth wrapper differs.
- **Mini App = dashboard**: Not just onboarding - it's the control panel for all your bots.
- **Dogfooding**: Master bot IS OpenClaw. Proves the product works.
- **No new bot frameworks**: No grammY. OpenClaw + skill + React Mini App.
- **AI-driven conversation**: Claude handles the friendly parts. Mini App handles the structured parts.
- **Security-first**: Rate limiting + encryption + input validation + initData expiry before launch.
- **Generic cloud interface**: GCP Mode A now, AWS/Hetzner/user-GCP later.
