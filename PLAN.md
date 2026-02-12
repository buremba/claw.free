# Telegram Bot Onboarding System - Implementation Plan

## Decisions Log

| Question | Decision | Rationale |
|----------|----------|-----------|
| Master bot isolation | Restrict shell to 6 onboarding scripts only | Multiple strangers use the bot; no freeform shell |
| User VM OS | Debian/Ubuntu | Hackable, easy to customize, apt package manager |
| Custom skills | Via bot conversation + curated marketplace | Users say "install this skill" or browse a registry |
| SSH repair access | User explicitly grants access | More secure; master bot asks before connecting |
| Bot discovery | t.me bot link only | No phone number needed |
| GCP mode | Mode A (we provide GCP) for MVP | Generic interface, implement only platform-provided for now |
| Bot token verification | Trust + webhook validation for MVP | Set webhook to prove token control; Mini App in Phase 2 |
| Security bugs | Fix critical ones now | Rate limiting, token encryption, CSRF |

---

## Overview

Deploy an **OpenClaw instance** on Railway as the master onboarding bot. It's just OpenClaw configured with a system prompt and skills that guide users through setting up their own bot. No custom bot framework needed - we dogfood our own product.

---

## Architecture

```
Railway (our infra)
├── OpenClaw Gateway (Telegram bot, restricted shell - 6 scripts only)
├── Hono API Server (existing, extended with deploy + bridge endpoints)
├── PostgreSQL (session + deployment + user tracking)
└── Platform GCP Service Account (deploys user VMs in our project)

Platform GCP Project (our infra, Mode A)
└── Per-user Debian/Ubuntu VMs (OpenClaw + user's bot)
    ├── OpenClaw gateway (user's Telegram bot)
    ├── Bootstrap provider (LLM auth flow)
    └── User workspace (skills, files, customizations)
```

The master bot is OpenClaw talking to users via Telegram, with a skill that can:
- Validate Telegram bot tokens (+ set webhook to prove control)
- Trigger GCP deployments via the Hono API
- Send the first message via the user's new bot
- Track deployment status
- SSH into user VMs for repair (only when user grants access)

---

## How It Works

```
1. User visits website → clicks "Open in Telegram" → t.me/ClawFreeBot
2. User sends /start
3. OpenClaw (with onboarding system prompt) greets them, explains the service
4. AI asks: "Which AI provider do you want? Claude, ChatGPT, or Kimi?"
5. AI asks: "Create a bot on @BotFather and send me the token"
6. User pastes token → skill validates via getMe + sets webhook to verify control
7. AI sends Google OAuth link (for identity, not GCP access - Mode A)
8. User logs in → callback marks bridge state complete
9. AI detects auth complete → triggers deployment via API (platform GCP)
10. AI updates user on progress as VM boots
11. Once live → skill sends first message from user's new bot
12. AI confirms: "Your bot @YourBotName is live! Go talk to it."
```

---

## Security Hardening (Fix Now)

These critical issues exist today and must be fixed before exposing the master bot to strangers:

### 1. Rate Limiting
- Add per-IP rate limiting to all API endpoints (express-rate-limit or hono middleware)
- Rate limit the Telegram bridge endpoints aggressively (5 req/min per chat_id)
- Rate limit deploy endpoints (1 deploy per user per 10 minutes)

### 2. Token Encryption at Rest
- Encrypt bot tokens in the database using AES-256-GCM
- Derive encryption key from `ENCRYPTION_KEY` env var
- Never log tokens in plaintext

### 3. CSRF Protection
- Add CSRF tokens to all state-changing endpoints
- OAuth state parameter already provides CSRF protection for auth flow
- Add `SameSite=Strict` to session cookies (currently `Lax`)

### 4. Input Validation
- Validate bot token format before making Telegram API calls (`/^\d+:[A-Za-z0-9_-]{35}$/`)
- Sanitize all user input in deploy parameters
- Validate GCP project IDs, zones against allowlists

---

## Master Bot Shell Restriction

The master bot's OpenClaw config restricts the shell tool to **only** execute the 6 onboarding scripts. No freeform shell access.

**Implementation approach** - OpenClaw skill with `shell` tool but system prompt instructs to only run scripts in `scripts/` directory. Additionally, the scripts directory is the only writable/executable path on the Railway container.

If OpenClaw supports a command allowlist in skill config, use that:
```yaml
tools:
  - shell:
      allowedCommands:
        - "bash scripts/validate-token.sh *"
        - "bash scripts/create-oauth-link.sh *"
        - "bash scripts/check-oauth.sh *"
        - "bash scripts/deploy-bot.sh *"
        - "bash scripts/deploy-status.sh *"
        - "bash scripts/send-first-message.sh *"
```

Fallback: wrap scripts in a dispatcher that validates the command:
```bash
#!/bin/bash
# scripts/run.sh - only dispatcher the AI calls
ALLOWED="validate-token|create-oauth-link|check-oauth|deploy-bot|deploy-status|send-first-message"
SCRIPT="$1"; shift
if [[ "$SCRIPT" =~ ^($ALLOWED)$ ]]; then
  exec bash "$(dirname "$0")/${SCRIPT}.sh" "$@"
else
  echo "ERROR: Unknown script: $SCRIPT"
  exit 1
fi
```

---

## Bot Token Verification

### MVP: Trust + Webhook Validation
1. Call `getMe` with the pasted token → validates token is real, gets bot username
2. Call `setWebhook` with a temporary URL → proves the token holder has control
3. If webhook set succeeds, token is valid and under the user's control
4. During deployment, the real webhook URL replaces the temporary one

### Phase 2: Telegram Mini App
A Mini App provides `initData` signed by Telegram containing verified user ID. Benefits:
- Replace the web onboarding wizard entirely (runs inside Telegram)
- Handle Google OAuth inside the Mini App webview
- Cryptographic proof of Telegram identity (no faking)
- Combined with webhook validation = strong ownership proof
- Could replace the OAuth bridge (Mini App IS a web page with verified identity)

---

## Cloud Provider Abstraction

Design a generic interface, implement only GCP Mode A for MVP:

```typescript
interface CloudProvider {
  name: string;
  createVM(config: VMConfig): Promise<DeploymentResult>;
  getVMStatus(id: string): Promise<VMStatus>;
  deleteVM(id: string): Promise<void>;
  sshInto(id: string): Promise<SSHConnection>; // for repair
}

interface VMConfig {
  botToken: string;
  llmProvider: 'claude' | 'openai' | 'kimi';
  botName: string;
  userId: string;
  // Provider-specific config injected by implementation
}

// MVP: Only this implementation exists
class GCPPlatformProvider implements CloudProvider {
  // Uses platform service account
  // Deploys to platform's GCP project
  // Debian/Ubuntu base image
}

// Future: User brings their own GCP
class GCPUserProvider implements CloudProvider { ... }

// Future: Other providers
class AWSProvider implements CloudProvider { ... }
class HetznerProvider implements CloudProvider { ... }
```

---

## User VM: Debian/Ubuntu

Replace the NixOS-based VM image with Debian/Ubuntu:

### Base Image
- Debian 12 (Bookworm) or Ubuntu 24.04 LTS
- Pre-installed: OpenClaw CLI, Node.js 22, curl, git
- Pre-installed CLI tools: claude, codex, gemini
- Startup script pulls latest claw-free-provider from repo
- Systemd services for openclaw-gateway and claw-free-provider

### Why Debian/Ubuntu over NixOS
- Users can `apt install` anything
- Easy to SSH into and debug
- Familiar to most developers
- Simpler startup scripts (bash instead of Nix expressions)
- Smaller image, faster boot

### Migration Path
1. Create new Debian/Ubuntu base image with Packer or GCE image builder
2. Startup script replaces NixOS module system with simple bash
3. Same metadata interface (TELEGRAM_TOKEN, LLM_PROVIDER, BOT_NAME)
4. Same guest attributes for progress reporting

---

## Custom Skills

Users can add skills to their bot two ways:

### Via Bot Conversation (Primary)
User tells their bot: "Install the weather skill" or "Add a skill that can search the web"
- Bot uses its shell access to download and configure the skill
- Skills are git repos or tarballs with a SKILL.md
- Bot adds the skill to its OpenClaw config and restarts

### Curated Marketplace (Phase 2)
- Registry of approved skills hosted on our platform
- Master bot can list available skills: "What skills can I add?"
- User picks one, master bot (or user's bot) installs it
- Skills are versioned and reviewed for safety

### Skill Format
Standard OpenClaw skill format:
```
my-skill/
├── SKILL.md          # Describes the skill, tools needed
└── scripts/          # Shell scripts the skill uses
    └── ...
```

---

## SSH Repair Access

When a user's bot is broken and they text the master bot for help:

### Flow
1. User messages master bot: "My bot is broken"
2. Master bot asks: "I can connect to your VM to diagnose the issue. This requires SSH access. Allow me to connect?"
3. User confirms
4. Master bot uses platform service account to SSH via GCP IAP tunnel
5. Runs diagnostic commands (check systemd services, logs, disk space, config)
6. Reports findings and offers to fix

### Implementation (Mode A - Easiest Path)
Since Mode A uses our platform GCP project, we already have access:
- Platform service account has `compute.instances.setMetadata` permission
- Use `gcloud compute ssh` via IAP tunnel (no public IP needed)
- Or use GCP OS Login with the service account
- No extra key management needed - IAP handles auth

### Safety
- Only connect when user explicitly grants permission
- Log all SSH sessions (commands + output) for audit
- Time-limit sessions (auto-disconnect after 10 minutes)
- Read-only by default; ask user before making changes

---

## What We Need

### 1. OpenClaw Config for the Master Bot

```json
{
  "gateway": { "mode": "local" },
  "agents": {
    "defaults": {
      "workspace": "/app/workspace",
      "systemPrompt": "You are the claw.free onboarding assistant...",
      "model": { "primary": "anthropic/claude-sonnet-4-20250514" }
    }
  },
  "channels": {
    "telegram": {
      "enabled": true,
      "botToken": "${TELEGRAM_BOT_TOKEN}",
      "dmPolicy": "open",
      "allowFrom": ["*"]
    }
  },
  "models": {
    "providers": {
      "anthropic": {
        "apiKey": "${ANTHROPIC_API_KEY}"
      }
    }
  }
}
```

### 2. Onboarding Skill

A skill with restricted shell tools that the AI can invoke during conversation:

```
skill/onboarding/
├── SKILL.md              # System prompt + tool descriptions
└── scripts/
    ├── run.sh                # Command dispatcher (security wrapper)
    ├── validate-token.sh     # Telegram getMe + setWebhook verification
    ├── create-oauth-link.sh  # Generate OAuth bridge URL
    ├── check-oauth.sh        # Poll bridge state completion
    ├── deploy-bot.sh         # Call Hono API to create VM
    ├── deploy-status.sh      # Poll deployment progress
    └── send-first-message.sh # Send message via user's new bot
```

**SKILL.md:**
```markdown
---
name: claw.free-onboarding
description: Help users set up their own AI Telegram bot
tools:
  - shell
---

You are the claw.free setup assistant. Guide users through creating
their own AI-powered Telegram bot.

## Steps

1. Ask which AI provider they want (Claude, ChatGPT, or Kimi)
2. Ask them to create a bot via @BotFather and paste the token
3. Validate the token: `bash scripts/run.sh validate-token <token>`
4. Generate OAuth link: `bash scripts/run.sh create-oauth-link <chat_id>`
5. Send the link and wait for auth: `bash scripts/run.sh check-oauth <state>`
6. Deploy their bot: `bash scripts/run.sh deploy-bot <token> <provider> <user_id>`
7. Check progress: `bash scripts/run.sh deploy-status <deployment_id>`
8. Send first message: `bash scripts/run.sh send-first-message <bot_token> <user_telegram_id>`

## Important
- ONLY execute commands through `scripts/run.sh` - never run arbitrary shell commands
- Always validate the bot token before proceeding
- If OAuth times out (10 min), offer to generate a new link
- Show deployment progress updates to the user
- After deployment, confirm the user's bot is responding
```

### 3. Skill Scripts

**run.sh** - Command dispatcher (security layer):
```bash
#!/bin/bash
set -euo pipefail
ALLOWED="validate-token|create-oauth-link|check-oauth|deploy-bot|deploy-status|send-first-message"
SCRIPT="$1"; shift
if [[ "$SCRIPT" =~ ^($ALLOWED)$ ]]; then
  exec bash "$(dirname "$0")/${SCRIPT}.sh" "$@"
else
  echo "ERROR: Unknown command: $SCRIPT" >&2
  exit 1
fi
```

**validate-token.sh** - Validates a Telegram bot token + proves control:
```bash
#!/bin/bash
set -euo pipefail
TOKEN="$1"

# Validate format
if [[ ! "$TOKEN" =~ ^[0-9]+:[A-Za-z0-9_-]{35}$ ]]; then
  echo '{"ok": false, "error": "Invalid token format"}'
  exit 1
fi

# Check token is real
RESULT=$(curl -s "https://api.telegram.org/bot${TOKEN}/getMe")
OK=$(echo "$RESULT" | jq -r '.ok')
if [ "$OK" != "true" ]; then
  echo '{"ok": false, "error": "Invalid bot token"}'
  exit 1
fi

# Set temporary webhook to prove control
TEMP_WEBHOOK="${BASE_URL}/api/webhook/verify/$(echo "$TOKEN" | md5sum | cut -d' ' -f1)"
WEBHOOK_RESULT=$(curl -s -X POST "https://api.telegram.org/bot${TOKEN}/setWebhook" \
  -H "Content-Type: application/json" \
  -d "{\"url\": \"${TEMP_WEBHOOK}\"}")

echo "$RESULT"
```

**create-oauth-link.sh** - Creates an OAuth bridge state and returns the login URL:
```bash
#!/bin/bash
set -euo pipefail
CHAT_ID="$1"
RESULT=$(curl -s -X POST "${BASE_URL}/api/auth/telegram-bridge" \
  -H "Content-Type: application/json" \
  -H "X-Internal-Key: ${INTERNAL_API_KEY}" \
  -d "{\"telegram_chat_id\": \"${CHAT_ID}\"}")
echo "$RESULT"
```

**check-oauth.sh** - Checks if OAuth bridge completed:
```bash
#!/bin/bash
set -euo pipefail
STATE="$1"
RESULT=$(curl -s "${BASE_URL}/api/auth/telegram-bridge/${STATE}" \
  -H "X-Internal-Key: ${INTERNAL_API_KEY}")
echo "$RESULT"
```

**deploy-bot.sh** - Triggers VM deployment (Mode A - platform GCP):
```bash
#!/bin/bash
set -euo pipefail
TOKEN="$1" PROVIDER="$2" USER_ID="$3"
RESULT=$(curl -s -X POST "${BASE_URL}/api/deploy/start" \
  -H "Content-Type: application/json" \
  -H "X-Internal-Key: ${INTERNAL_API_KEY}" \
  -d "{\"botToken\": \"${TOKEN}\", \"provider\": \"${PROVIDER}\", \"userId\": \"${USER_ID}\", \"mode\": \"platform\"}")
echo "$RESULT"
```

**deploy-status.sh** - Polls deployment status:
```bash
#!/bin/bash
set -euo pipefail
DEPLOYMENT_ID="$1"
RESULT=$(curl -s "${BASE_URL}/api/deploy/${DEPLOYMENT_ID}" \
  -H "X-Internal-Key: ${INTERNAL_API_KEY}")
echo "$RESULT"
```

**send-first-message.sh** - Sends first message from user's new bot:
```bash
#!/bin/bash
set -euo pipefail
BOT_TOKEN="$1" USER_ID="$2"
curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
  -H "Content-Type: application/json" \
  -d "{\"chat_id\": \"${USER_ID}\", \"text\": \"Hi! I'm your new AI assistant. Send me a message to get started!\"}"
```

### 4. Server-Side Changes (Hono API)

Minimal additions to the existing server:

**New endpoints:**
- `POST /api/auth/telegram-bridge` - Create OAuth bridge state (generates state token, returns login URL)
- `GET /api/auth/telegram-bridge/:state` - Check bridge completion status
- Modify `auth-callback-google.ts` - If bridge_state present, mark complete + show "close tab" page

**Modified `auth-google.ts`:**
- If `bridge_state` param exists, only request `openid email` scopes (Mode A doesn't need GCP scopes)

**New `POST /api/deploy/start` for bot-driven deploys (Mode A):**
- Accept `X-Internal-Key` auth (not cookie-based, since called from skill scripts)
- Use platform service account + platform GCP project
- Create Debian/Ubuntu VM with user's bot token in metadata

**Rate limiting middleware:**
- Per-IP: 60 req/min general, 10 req/min for auth endpoints
- Per-chat_id: 5 req/min for bridge endpoints
- Per-user: 1 deploy per 10 minutes

**Input validation middleware:**
- Bot token format validation
- GCP zone allowlist
- Sanitize all string inputs

### 5. Environment Variables

```env
# Required
TELEGRAM_BOT_TOKEN=        # Master bot's Telegram token
ANTHROPIC_API_KEY=         # AI model for the onboarding conversation
DATABASE_URL=              # PostgreSQL
GOOGLE_CLIENT_ID=          # OAuth (for user identity)
GOOGLE_CLIENT_SECRET=      # OAuth
BASE_URL=                  # Public URL (e.g., https://claw-free.up.railway.app)
INTERNAL_API_KEY=          # For skill scripts → API auth
ENCRYPTION_KEY=            # AES-256 key for encrypting tokens at rest

# Mode A - Platform GCP (required for MVP)
GCP_SERVICE_ACCOUNT_KEY=   # Platform GCP service account JSON
GCP_PROJECT_ID=            # Platform GCP project
```

### 6. Deployment on Railway

The master bot runs as an OpenClaw gateway process alongside the existing Hono server:

```json
// railway.json - start both processes
{
  "deploy": {
    "startCommand": "npm run start & openclaw gateway --port 18789",
    "healthcheckPath": "/healthz"
  }
}
```

Or use process-compose (already in the project for local dev) to run both.

### 7. Sandbox Hardening (User VMs)

**Read-only filesystem** - Debian/Ubuntu config via startup script:
- Mount root read-only via fstab
- Only `/var/lib/openclaw`, `/tmp`, `/var/log`, `/home/openclaw` writable

**Network allowlist** - iptables in startup script:
- Allow: api.anthropic.com, api.openai.com, api.moonshot.cn, api.telegram.org, metadata.google.internal
- Allow: DNS (udp/tcp 53), loopback
- Allow: GCP IAP tunnel range (for SSH repair)
- Block: everything else

### 8. Website Changes

Replace the complex wizard with a simple landing page:
- Hero: "Get your own AI assistant in 2 minutes"
- Primary CTA: **"Open in Telegram"** → `t.me/ClawFreeBot`
- Secondary: existing wizard flow for power users who want self-hosted

---

## Implementation Order

| # | What | Description | Effort |
|---|------|-------------|--------|
| 0 | Security fixes | Rate limiting, token encryption, input validation | 1-2 days |
| 1 | Cloud provider abstraction | Generic interface + GCP Mode A implementation | 1 day |
| 2 | Debian/Ubuntu VM image | Replace NixOS image, same metadata interface | 1-2 days |
| 3 | OpenClaw on Railway | Get openclaw gateway running with our bot token | 0.5 day |
| 4 | Onboarding skill | SKILL.md + restricted scripts + run.sh dispatcher | 1 day |
| 5 | OAuth bridge | 2 new API endpoints for Telegram ↔ Google login | 1 day |
| 6 | Deploy from skill | Extend deploy API with internal auth, Mode A | 1 day |
| 7 | Token verification | getMe + setWebhook validation | 0.5 day |
| 8 | First message + completion | Script that sends first message, end-to-end test | 0.5 day |
| 9 | SSH repair | IAP tunnel access with user permission flow | 1 day |
| 10 | Sandbox hardening | Read-only FS + network allowlist on user VMs | 1 day |
| 11 | Website update | Landing page with Telegram link as primary CTA | 0.5 day |
| 12 | Custom skills via conversation | Users install skills by talking to their bot | 1 day |
| 13 | Skill marketplace | Curated registry of approved skills | 2-3 days |

**Phase 1 (MVP): Steps 0-8** - Security + working end-to-end onboarding via Telegram.
**Phase 2: Steps 9-11** - SSH repair + sandbox + website.
**Phase 3: Steps 12-13** - Custom skills + marketplace.
**Phase 4: Telegram Mini App** - Replace OAuth bridge + web wizard with in-Telegram experience.
**Phase 5: Whitelabel** - Reseller support with multi-tenant master bots.

---

## Whitelabel (Phase 5)

Each reseller deploys their own OpenClaw master bot instance with:
- Their own `TELEGRAM_BOT_TOKEN`
- Their own branding in the system prompt
- Their own `GCP_SERVICE_ACCOUNT_KEY` (optional)
- Shared or separate Hono API backend

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
  owner_user_id UUID REFERENCES "user"(id),
  created_at TIMESTAMPTZ DEFAULT now()
);
```

Multi-tenant routing: each reseller's bot gets a separate OpenClaw gateway process or a single gateway with multi-bot support (depending on OpenClaw's capabilities).

---

## Why This Approach

- **Dogfooding**: The master bot IS OpenClaw. If it's good enough to onboard users, it proves the product works.
- **No new frameworks**: No grammY, no custom bot code. Just OpenClaw + a skill + shell scripts.
- **AI-driven conversation**: Real AI (Claude) handles the conversation, not a rigid state machine. It can handle edge cases, answer questions, recover from errors naturally.
- **Minimal new code**: ~7 small shell scripts, 2-3 API endpoints, 1 skill definition. The rest is config.
- **Same deployment model**: Master bot uses the same OpenClaw that end users get. If we improve OpenClaw, the master bot improves too.
- **Security-first**: Shell restriction + rate limiting + token encryption before going public.
- **Generic cloud interface**: Easy to add AWS, Hetzner, etc. later without rewriting deploy logic.
- **User-hackable VMs**: Debian/Ubuntu means users can customize freely. Combined with skill installation via conversation, the platform grows with users.
