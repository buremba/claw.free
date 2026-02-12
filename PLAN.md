# Telegram Bot Onboarding System - Implementation Plan

## Decisions Log

| Question | Decision | Rationale |
|----------|----------|-----------|
| Master bot isolation | Restrict shell to onboarding scripts only | Multiple strangers use the bot; no freeform shell |
| User VM OS | Keep NixOS + nix-shell for user customization | More reliable, reproducible, atomic rollbacks; nix-shell covers user needs |
| Custom skills | Via bot conversation + curated marketplace | Users say "install this skill" or browse a registry |
| SSH repair access | User explicitly confirms in chat | Mode A = we already have access; confirmation is UX, not technical |
| Bot discovery | t.me bot link only | No phone number needed |
| GCP mode | Mode A (we provide GCP) for MVP | Generic interface, implement only platform-provided for now |
| Authentication | Telegram identity via Mini App `initData` | No Google OAuth needed for MVP; Telegram IS the identity |
| Token + LLM credentials | Via Mini App (never in chat) | Tokens in chat history feel insecure; Mini App = HTTPS direct to API |
| Security bugs | Fix critical ones now | Rate limiting, token encryption, input validation |
| Better Auth | Not needed for MVP | Custom initData validation is simpler; Better Auth assumes OAuth which doesn't fit Telegram |
| OpenClaw web_app buttons | Curl workaround via skill script | OpenClaw only supports callback_data buttons; Issue #4280 closed as "not planned" |
| Database | Extend existing owletto PostgreSQL | Add channel_identity table alongside existing user/account tables |

---

## Spike Results

### OpenClaw Telegram Button Support (Tested)

**Finding**: OpenClaw supports ONLY `callback_data` inline buttons. No `web_app`, `url`, or other button types.

**Evidence**: OpenClaw docs confirm buttons are `[{ text, callback_data }]` only. GitHub Issue #4280 (plugin callback handler for Telegram inline buttons) was **closed as "not planned"** (Feb 1, 2026).

**Workaround**: Skill script calls Telegram API directly via curl:
```bash
# scripts/send-webapp-button.sh
curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  -H "Content-Type: application/json" \
  -d '{
    "chat_id": "'$1'",
    "text": "Tap below to set up your bot:",
    "reply_markup": {
      "inline_keyboard": [[{
        "text": "Open Setup",
        "web_app": { "url": "'${BASE_URL}'/mini" }
      }]]
    }
  }'
```

**Why this works**: Skills have access to `TELEGRAM_BOT_TOKEN` env var and the AI can pass `chat_id` as a parameter. Confirmed via OpenClaw skill docs and existing claw.free skill patterns.

### Better Auth Assessment

**Finding**: Not in use, not recommended. Telegram `initData` is HMAC-signed JSON, not OAuth. Better Auth assumes OAuth/OIDC flows and would require a custom provider adapter (2-3 weeks) vs custom code (1 week, already designed).

**For account linking**: Use the existing owletto database. Add `channel_identity` table that references the existing `user` table. A user can have multiple identities (telegram, google, whatsapp) all pointing to the same user record.

### NixOS vs Debian Assessment

**Finding**: Keep NixOS. It's more reliable and easier to maintain long-term.

**Rationale**:
- VMs are managed infrastructure, not user-customized machines
- Users interact via Telegram bot, not SSH
- NixOS gives reproducible builds, atomic rollbacks, no config drift
- Current NixOS setup is already working and tested
- Pre-install common build tools in base image for 90% of skill use cases
- For custom skill deps, provide nix-shell in user workspace

**Migration path**: None needed. Enhance existing NixOS config with:
1. Pre-installed build tools (python3, postgresql-dev, etc.)
2. Nix-shell templates for skill development
3. Writable `/var/lib/openclaw/` for user workspace

---

## Overview

Deploy an **OpenClaw instance** on Railway as the master onboarding bot. The bot handles the conversational parts (greeting, provider selection, progress updates, support). A **Telegram Mini App** handles all sensitive inputs (bot token, LLM credentials) and serves as the user dashboard (list bots, manage skills, view status).

No Google OAuth needed for MVP. Mode A uses our platform GCP, and Telegram `initData` provides cryptographically verified user identity. No grammY or custom bot frameworks - just OpenClaw + a skill + a React Mini App.

The Mini App also handles LLM provider authentication (Claude OAuth, OpenAI API key, Kimi key), which could **eliminate the bootstrap provider on user VMs entirely**.

---

## Architecture

```
Railway (our infra)
├── OpenClaw Gateway (master Telegram bot, restricted shell)
├── Hono API Server (existing owletto, extended with deploy + Mini App endpoints)
├── Mini App (React, served by Hono, opened inside Telegram)
├── PostgreSQL (existing owletto DB, extended with channel_identity + deployments)
└── Platform GCP Service Account (deploys user VMs in our project)

Platform GCP Project (our infra, Mode A)
└── Per-user NixOS VMs
    ├── OpenClaw gateway (user's Telegram bot)
    ├── LLM credentials (passed via metadata from Mini App, no bootstrap needed)
    └── User workspace (skills, files, customizations via nix-shell)
```

---

## How It Works

```
1. User visits website → clicks "Open in Telegram" → t.me/ClawFreeBot
2. User sends /start
3. Bot greets them, explains the service
4. Bot asks: "Which AI provider do you want? Claude, ChatGPT, or Kimi?"
5. Bot sends Mini App button via curl workaround (web_app inline keyboard)
6. Mini App opens inside Telegram:
   a. Validates initData (verified Telegram user ID)
   b. Shows "Create a bot" step - links to @BotFather instructions
   c. User pastes bot token in Mini App form (never in chat)
   d. Mini App validates token (getMe + setWebhook)
   e. User enters LLM credentials in Mini App:
      - Claude: OAuth flow or API key
      - OpenAI: API key
      - Kimi: API key
   f. Mini App shows "Deploy" button → triggers deployment
   g. All credentials passed to VM via GCP metadata (encrypted)
   h. Mini App shows real-time deployment progress
   i. Deployment complete → Mini App shows success + link to new bot
7. Bot also receives deployment events, sends chat message:
   "Your bot @YourBotName is live! Go talk to it."
8. User returns to Mini App anytime to see their bots dashboard
```

**Key simplification**: LLM auth happens in Mini App before deployment. The VM boots with credentials already configured. **No bootstrap provider needed on user VMs.** This eliminates the entire multi-stage setup flow on the VM side.

---

## Identity Model

Uses existing owletto PostgreSQL database. Adds `channel_identity` table for multi-channel identity linking.

```
Telegram  → initData (signed by Telegram, contains user ID, name, photo)
WhatsApp  → phone number (verified by WhatsApp, via Flows callback)
Discord   → Discord user ID (via interaction tokens)
Google    → existing OAuth flow (for web access + future Mode B GCP)
```

### Database Changes (extend existing owletto schema)

Keep existing `user` and `account` tables. Add:

```sql
-- Links channel-specific identities to existing user table
CREATE TABLE channel_identity (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES "user"(id),
  channel_type TEXT NOT NULL,          -- 'telegram', 'whatsapp', 'discord'
  channel_user_id TEXT NOT NULL,       -- telegram user ID, phone number, etc.
  display_name TEXT,
  avatar_url TEXT,
  raw_data JSONB,                      -- full initData or profile payload
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(channel_type, channel_user_id)
);

-- Persistent deployment tracking (replaces in-memory deploy store)
CREATE TABLE deployment (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES "user"(id),
  bot_token_encrypted TEXT NOT NULL,
  bot_username TEXT,
  llm_provider TEXT NOT NULL,          -- 'claude', 'openai', 'kimi'
  llm_credentials_encrypted TEXT,      -- encrypted API key or OAuth token
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

The existing Google `account` table continues to work for Google OAuth users. When a Telegram user later links their Google account, both `channel_identity` (telegram) and `account` (google) point to the same `user.id`.

---

## Telegram Mini App

The Mini App is a React SPA served by our Hono server, opened as a WebApp inside Telegram.

### How the Bot Sends the Mini App Button

Since OpenClaw doesn't support `web_app` buttons natively, the skill uses a curl script:

```bash
# scripts/send-webapp-button.sh - sends Mini App button via Telegram API
#!/bin/bash
set -euo pipefail
CHAT_ID="$1"
TEXT="${2:-Tap below to set up your bot:}"

curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  -H "Content-Type: application/json" \
  -d "{
    \"chat_id\": \"${CHAT_ID}\",
    \"text\": \"${TEXT}\",
    \"reply_markup\": {
      \"inline_keyboard\": [[{
        \"text\": \"Open Setup\",
        \"web_app\": { \"url\": \"${BASE_URL}/mini\" }
      }]]
    }
  }"
```

Also register as permanent menu button with BotFather:
```
/setmenubutton → Web App URL: https://claw-free.up.railway.app/mini
```

### initData Validation

Telegram signs `initData` with the bot token using HMAC-SHA256:

```typescript
import { createHmac } from 'crypto';

function validateInitData(initData: string, botToken: string): TelegramUser | null {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

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
- Step 3: LLM provider credentials:
  - Claude: OAuth flow (opens in Mini App webview) or paste API key
  - OpenAI: Paste API key
  - Kimi: Paste API key
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

Same React UI, different auth wrappers:

```
/mini              → Telegram Mini App (initData auth)
/mini?wa=<token>   → WhatsApp Flows (WhatsApp signed payload auth)
/app               → Web standalone (Google OAuth auth, future)
```

---

## Security Hardening (Fix Now)

### 1. Rate Limiting
- Per-IP: 60 req/min general, 10 req/min for deploy endpoints
- Per-user: 1 deploy per 10 minutes
- Mini App API: 30 req/min per Telegram user ID

### 2. Token Encryption at Rest
- Encrypt bot tokens AND LLM credentials using AES-256-GCM
- Stored in `deployment.bot_token_encrypted` and `deployment.llm_credentials_encrypted`
- Derive key from `ENCRYPTION_KEY` env var
- Never log credentials in plaintext

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
ALLOWED="send-webapp-button|deploy-status|send-first-message|diagnose-vm"
SCRIPT="$1"; shift
if [[ "$SCRIPT" =~ ^($ALLOWED)$ ]]; then
  exec bash "$(dirname "$0")/${SCRIPT}.sh" "$@"
else
  echo "ERROR: Unknown command: $SCRIPT" >&2
  exit 1
fi
```

| Script | Purpose |
|--------|---------|
| `send-webapp-button.sh` | Send Mini App button via Telegram API (curl workaround) |
| `deploy-status.sh` | Poll deployment progress |
| `send-first-message.sh` | Send welcome message from user's new bot |
| `diagnose-vm.sh` | SSH into user VM for repair (with permission) |

Token validation and deployment happen via Mini App → API, not through bot scripts.

---

## Bot Token Verification

Token is entered in the Mini App, validated server-side:

1. **Format check**: regex validation
2. **`getMe`**: proves token is real, gets bot username + ID
3. **`setWebhook`**: sets our temporary webhook URL, proves token has control
4. **`deleteWebhook`** on deployment: real webhook set by OpenClaw on the VM

Token never appears in Telegram chat history.

---

## LLM Credentials via Mini App

The Mini App handles LLM provider authentication, eliminating the bootstrap provider on VMs:

### Claude (Anthropic)
- Mini App shows Claude OAuth flow in webview (same device auth as current bootstrap)
- Or: user pastes API key directly
- Credential encrypted and stored, passed to VM via metadata

### OpenAI (ChatGPT)
- User pastes API key in Mini App form
- Credential encrypted and stored, passed to VM via metadata

### Kimi (NVIDIA)
- User pastes API key in Mini App form
- Credential encrypted and stored, passed to VM via metadata

### Impact on VM Setup
- **Bootstrap provider (`claw-free-provider`) can be removed** from user VMs
- VM boots with LLM credentials already in metadata
- OpenClaw gateway starts immediately with real model configured
- Faster boot, simpler VM, fewer systemd services

---

## Cloud Provider Abstraction

Generic interface, only GCP Mode A implemented:

```typescript
interface CloudProvider {
  name: string;
  createVM(config: VMConfig): Promise<{ deploymentId: string }>;
  getVMStatus(deploymentId: string): Promise<VMStatus>;
  deleteVM(deploymentId: string): Promise<void>;
  execOnVM(deploymentId: string, command: string): Promise<string>;
}

interface VMConfig {
  botToken: string;
  llmProvider: 'claude' | 'openai' | 'kimi';
  llmCredentials: string;  // encrypted
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

---

## User VM: NixOS (Keep + Enhance)

### Current Setup (keep as-is)
- NixOS with declarative config in `infra/nixos/base/default.nix`
- Pre-built GCE image (`nixos-openclaw` family)
- Systemd services for openclaw-gateway
- Metadata-driven configuration

### Enhancements
1. **Remove bootstrap provider** - LLM credentials come from metadata (set by Mini App)
2. **Pre-install common build tools** for skills:
   ```nix
   environment.systemPackages = with pkgs; [
     python3 postgresql jq curl git gcc gnumake
   ];
   ```
3. **Add nix-shell templates** in user workspace for custom skill dependencies
4. **Simplify startup** - no more multi-stage LLM auth flow on the VM

### Why Keep NixOS
- Reproducible builds (every user gets identical baseline)
- Atomic upgrades and rollbacks
- No configuration drift over VM lifetime
- Faster boot (no runtime `apt install`)
- Already working and tested
- Immutable base prevents users from breaking system
- nix-shell provides per-skill customization without touching base

---

## Server-Side Changes (Hono API)

### New Endpoints

**Mini App Auth:**
- `POST /api/mini/auth` - Validate `initData`, find/create user, return JWT

**Mini App Operations:**
- `GET /api/mini/bots` - List user's deployed bots
- `POST /api/mini/bots` - Create bot (validate token + LLM creds + deploy)
- `GET /api/mini/bots/:id` - Bot detail (status, IP, logs)
- `POST /api/mini/bots/:id/restart` - Restart bot's VM services
- `DELETE /api/mini/bots/:id` - Stop and delete bot
- `POST /api/mini/bots/:id/repair` - Grant repair access

**Token + Credential Validation:**
- `POST /api/mini/validate-token` - Validate bot token (getMe + setWebhook)
- `POST /api/mini/validate-llm` - Validate LLM API key (test call)

**Deploy API (called by skill scripts):**
- `POST /api/deploy/start` - Internal, X-Internal-Key auth, Mode A
- `GET /api/deploy/:id` - Poll status

### Removed from previous plans
- ~~OAuth bridge endpoints~~ - Mini App replaces this
- ~~Google OAuth modifications~~ - Not needed for MVP
- ~~Bootstrap provider~~ - LLM auth moves to Mini App

---

## Environment Variables

```env
# Required
TELEGRAM_BOT_TOKEN=        # Master bot's Telegram token
ANTHROPIC_API_KEY=         # AI model for the onboarding conversation
DATABASE_URL=              # Existing owletto PostgreSQL
BASE_URL=                  # Public URL (e.g., https://claw-free.up.railway.app)
INTERNAL_API_KEY=          # For skill scripts → API auth
ENCRYPTION_KEY=            # AES-256 key for encrypting tokens/credentials at rest

# Mode A - Platform GCP (required for MVP)
GCP_SERVICE_ACCOUNT_KEY=   # Platform GCP service account JSON
GCP_PROJECT_ID=            # Platform GCP project

# Kept for existing web flow (not needed for Telegram Mini App flow)
GOOGLE_CLIENT_ID=          # For web-based Google OAuth (existing)
GOOGLE_CLIENT_SECRET=      # For web-based Google OAuth (existing)
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
3. Send them to the Mini App:
   `bash scripts/run.sh send-webapp-button <chat_id> "Great choice! Tap below to set up your bot."`
4. Mini App handles: token input, LLM credentials, deployment
5. Monitor deployment progress: `bash scripts/run.sh deploy-status <id>`
6. When complete, confirm in chat: "Your bot @BotName is live!"
7. Send first message: `bash scripts/run.sh send-first-message <bot_token> <user_id>`

## Support Flow

If a user says their bot is broken:
1. Ask for permission to diagnose: "Can I connect to check what's wrong?"
2. On confirmation: `bash scripts/run.sh diagnose-vm <deployment_id>`
3. Report findings and offer fixes

## Returning Users

If user already has bots deployed:
1. Send Mini App button: "Tap below to manage your bots"
2. Mini App shows dashboard with all their bots

## Important
- ONLY execute commands through `scripts/run.sh`
- Never ask for bot tokens or API keys in chat - ALWAYS direct to Mini App
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

## SSH Repair / VM Diagnostics

Since Mode A = we own the infrastructure, we already have access. The "user grants permission" is a conversational confirmation, not a technical grant.

```bash
# scripts/diagnose-vm.sh
#!/bin/bash
set -euo pipefail
DEPLOYMENT_ID="$1"
VM_INFO=$(curl -s "${BASE_URL}/api/deploy/${DEPLOYMENT_ID}" \
  -H "X-Internal-Key: ${INTERNAL_API_KEY}")
VM_NAME=$(echo "$VM_INFO" | jq -r '.vmName')
VM_ZONE=$(echo "$VM_INFO" | jq -r '.zone')

gcloud compute ssh "$VM_NAME" --zone="$VM_ZONE" --tunnel-through-iap \
  --command="systemctl status openclaw-gateway; journalctl -u openclaw-gateway --no-pager -n 50; df -h; free -h"
```

---

## Implementation Order

| # | What | Description |
|---|------|-------------|
| 0 | Security fixes | Rate limiting, token encryption, input validation |
| 1 | DB schema update | Add channel_identity + deployment tables to owletto DB |
| 2 | Cloud provider abstraction | Generic interface + GCP Mode A implementation |
| 3 | NixOS image update | Remove bootstrap provider, accept LLM creds via metadata |
| 4 | Mini App: initData auth | Validate Telegram initData, issue JWT, link to owletto user |
| 5 | Mini App: create bot flow | Token input, LLM credentials, deploy trigger, progress |
| 6 | Mini App: dashboard | List bots, status, quick actions |
| 7 | OpenClaw on Railway | Master bot gateway with onboarding skill |
| 8 | Onboarding skill | SKILL.md + restricted scripts + send-webapp-button curl workaround |
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
  mini_app_theme JSONB,
  owner_user_id UUID REFERENCES "user"(id),
  created_at TIMESTAMPTZ DEFAULT now()
);
```

---

## Why This Approach

- **No OAuth needed for MVP**: Telegram identity is sufficient for Mode A.
- **Token + LLM creds never in chat**: Mini App handles ALL sensitive inputs via HTTPS.
- **No bootstrap provider**: LLM auth in Mini App before deployment. VM boots ready to go.
- **Cross-channel ready**: Same Mini App UI for WhatsApp Flows, Discord, web.
- **Mini App = dashboard**: Onboarding + management + skills in one place.
- **Dogfooding**: Master bot IS OpenClaw. Proves the product works.
- **No new bot frameworks**: No grammY. OpenClaw + skill + curl workaround for web_app buttons.
- **NixOS reliability**: Reproducible, atomic, no drift. Enhanced with nix-shell for user flexibility.
- **Existing DB**: Extends owletto PostgreSQL, keeps Google OAuth working alongside Telegram identity.
- **Security-first**: Rate limiting + encryption + initData expiry before launch.
- **Generic cloud interface**: GCP Mode A now, AWS/Hetzner/user-GCP later.
