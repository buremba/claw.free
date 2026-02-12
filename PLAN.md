# Whitelabel Telegram Bot Onboarding System - Implementation Plan

## Overview

Deploy an **OpenClaw instance** on Railway as the master onboarding bot. It's just OpenClaw configured with a system prompt and skills that guide users through setting up their own bot. No custom bot framework needed - we dogfood our own product.

---

## Architecture

```
Railway (our infra)
├── OpenClaw Gateway (Telegram bot, uses our TELEGRAM_BOT_TOKEN)
├── Hono API Server (existing, extended with deploy endpoints)
├── PostgreSQL (session + deployment tracking)
└── Platform GCP Service Account (optional, for deploying user VMs)

User's GCP (or platform's)
└── Per-user OpenClaw VM (existing flow, sandboxed)
```

The master bot is literally OpenClaw talking to users via Telegram, with a skill that can:
- Validate Telegram bot tokens
- Trigger GCP deployments via the Hono API
- Send the first message via the user's new bot
- Track deployment status

---

## How It Works

```
1. User visits website → clicks "Open in Telegram" → t.me/ClawFreeBot
2. User sends /start
3. OpenClaw (with onboarding system prompt) greets them, explains the service
4. AI asks: "Which AI provider do you want? Claude, ChatGPT, or Kimi?"
5. AI asks: "Create a bot on @BotFather and send me the token"
6. User pastes token → skill script validates via Telegram getMe API
7. AI sends Google OAuth link (inline button or URL)
8. User logs in → callback marks bridge state complete
9. AI detects auth complete → triggers deployment via API
10. AI updates user on progress as VM boots
11. Once live → skill sends first message from user's new bot
12. AI confirms: "Your bot @YourBotName is live! Go talk to it."
```

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

A skill with shell tools that the AI can invoke during conversation:

```
skill/onboarding/
├── SKILL.md              # System prompt + tool descriptions
└── scripts/
    ├── validate-token.sh     # Telegram getMe API call
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
3. Validate the token: `bash scripts/validate-token.sh <token>`
4. Generate OAuth link: `bash scripts/create-oauth-link.sh <chat_id>`
5. Send the link and wait for auth: `bash scripts/check-oauth.sh <state>`
6. Deploy their bot: `bash scripts/deploy-bot.sh <token> <provider> <user_id> <project_id>`
7. Check progress: `bash scripts/deploy-status.sh <deployment_id>`
8. Send first message: `bash scripts/send-first-message.sh <bot_token> <user_telegram_id>`

## Important
- Always validate the bot token before proceeding
- If OAuth times out (10 min), offer to generate a new link
- Show deployment progress updates to the user
- After deployment, confirm the user's bot is responding
```

### 3. Skill Scripts

**validate-token.sh** - Validates a Telegram bot token:
```bash
#!/bin/bash
TOKEN="$1"
RESULT=$(curl -s "https://api.telegram.org/bot${TOKEN}/getMe")
echo "$RESULT"
# Returns bot username + id if valid, error if not
```

**create-oauth-link.sh** - Creates an OAuth bridge state and returns the login URL:
```bash
#!/bin/bash
CHAT_ID="$1"
RESULT=$(curl -s -X POST "${BASE_URL}/api/auth/telegram-bridge" \
  -H "Content-Type: application/json" \
  -d "{\"telegram_chat_id\": ${CHAT_ID}}")
echo "$RESULT"
# Returns { state: "abc123", url: "https://..." }
```

**check-oauth.sh** - Checks if OAuth bridge completed:
```bash
#!/bin/bash
STATE="$1"
RESULT=$(curl -s "${BASE_URL}/api/auth/telegram-bridge/${STATE}")
echo "$RESULT"
# Returns { completed: true/false, user_email: "..." }
```

**deploy-bot.sh** - Triggers VM deployment:
```bash
#!/bin/bash
TOKEN="$1" PROVIDER="$2" USER_ID="$3"
RESULT=$(curl -s -X POST "${BASE_URL}/api/deploy/start" \
  -H "Content-Type: application/json" \
  -H "X-Internal-Key: ${INTERNAL_API_KEY}" \
  -d "{\"botToken\": \"${TOKEN}\", \"provider\": \"${PROVIDER}\", \"userId\": \"${USER_ID}\"}")
echo "$RESULT"
```

**deploy-status.sh** - Polls deployment status:
```bash
#!/bin/bash
DEPLOYMENT_ID="$1"
RESULT=$(curl -s "${BASE_URL}/api/deploy/${DEPLOYMENT_ID}")
echo "$RESULT"
```

**send-first-message.sh** - Sends first message from user's new bot:
```bash
#!/bin/bash
BOT_TOKEN="$1" USER_ID="$2"
curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
  -H "Content-Type: application/json" \
  -d "{\"chat_id\": ${USER_ID}, \"text\": \"Hi! I'm your new AI assistant. Send /start to begin setup!\"}"
```

### 4. Server-Side Changes (Hono API)

Minimal additions to the existing server:

**New endpoints:**
- `POST /api/auth/telegram-bridge` - Create OAuth bridge state (generates state token, returns login URL)
- `GET /api/auth/telegram-bridge/:state` - Check bridge completion status
- Modify `auth-callback-google.ts` - If bridge_state present, mark complete + show "close tab" page

**Modified `auth-google.ts`:**
- If `bridge_state` param exists, adjust scopes:
  - `GCP_SERVICE_ACCOUNT_KEY` set → `openid email` only
  - Not set → full GCP scopes (existing behavior)

**New `POST /api/deploy/start` for bot-driven deploys:**
- Accept internal API key auth (not cookie-based, since called from skill scripts)
- Mode A: use platform service account + project
- Mode B: use user's OAuth token from bridge state

### 5. Environment Variables

```env
# Required
TELEGRAM_BOT_TOKEN=        # Master bot's Telegram token
ANTHROPIC_API_KEY=         # AI model for the onboarding conversation
DATABASE_URL=              # PostgreSQL
GOOGLE_CLIENT_ID=          # OAuth
GOOGLE_CLIENT_SECRET=      # OAuth
BASE_URL=                  # Public URL
INTERNAL_API_KEY=          # For skill scripts → API auth

# Optional - Mode A (platform-provided GCP)
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

### 7. Sandbox Hardening (Deployed User VMs)

**Read-only filesystem** - NixOS config:
- Root mounted read-only
- Only `/var/lib/openclaw`, `/tmp`, `/var/log` writable

**Network allowlist** - iptables in NixOS config:
- Allow: api.anthropic.com, api.openai.com, api.moonshot.cn, api.telegram.org, metadata.google.internal
- Allow: DNS (udp/tcp 53), loopback
- Block: everything else

### 8. Website Changes

Replace the complex wizard with a simple landing page:
- Hero: "Get your own AI assistant in 2 minutes"
- Primary CTA: **"Open in Telegram"** → `t.me/{botUsername}?start=web`
- Secondary: existing wizard flow for power users

---

## Whitelabel (Phase 2)

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
  master_bot_token TEXT NOT NULL,
  system_prompt_override TEXT,       -- Custom greeting/branding
  gcp_service_account_key TEXT,      -- Their own GCP (optional)
  gcp_project_id TEXT,
  default_provider TEXT DEFAULT 'claude',
  max_deployments INT DEFAULT 100,
  owner_user_id UUID REFERENCES "user"(id),
  created_at TIMESTAMPTZ DEFAULT now()
);
```

Multi-tenant routing: each reseller's bot gets a separate OpenClaw gateway process or a single gateway with multi-bot support (depending on OpenClaw's capabilities).

---

## Implementation Order

| # | What | Description |
|---|------|-------------|
| 1 | OpenClaw on Railway | Get openclaw gateway running on Railway with our bot token |
| 2 | Onboarding skill | SKILL.md + scripts that guide users through setup |
| 3 | OAuth bridge | 2 new API endpoints for Telegram ↔ Google login |
| 4 | Deploy from skill | Extend deploy API with internal auth, Mode A support |
| 5 | Bot instruction | Script that sends first message via user's new bot |
| 6 | Sandbox hardening | Read-only FS + network allowlist on user VMs |
| 7 | Website update | Landing page with Telegram link as primary CTA |
| 8 | Whitelabel | Reseller DB + multi-tenant master bots |

**Phase 1 (MVP): Steps 1-5** - Working end-to-end onboarding via Telegram.
**Phase 2: Steps 6-7** - Security + website.
**Phase 3: Step 8** - Whitelabel for resellers.

---

## Why This Approach

- **Dogfooding**: The master bot IS OpenClaw. If it's good enough to onboard users, it proves the product works.
- **No new frameworks**: No grammY, no custom bot code. Just OpenClaw + a skill + shell scripts.
- **AI-driven conversation**: Real AI (Claude) handles the conversation, not a rigid state machine. It can handle edge cases, answer questions, recover from errors naturally.
- **Minimal new code**: ~6 small shell scripts, 2 API endpoints, 1 skill definition. The rest is config.
- **Same deployment model**: Master bot uses the same OpenClaw that end users get. If we improve OpenClaw, the master bot improves too.
