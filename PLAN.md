# Whitelabel Telegram Bot Onboarding System - Implementation Plan

## Overview

Build a **multi-tenant Telegram bot** (running on Railway) that serves as the onboarding gateway for claw.free. Users click a Telegram link on the website, interact with the bot to set up their own AI assistant, and the platform handles everything. The system supports **whitelabeling** so resellers can run their own branded version with their own master bot.

---

## Architecture

### Two Deployment Modes

The system supports two modes based on environment configuration:

**Mode A: Platform-Provided GCP (recommended for most users)**
- `GCP_SERVICE_ACCOUNT_KEY` is set in env
- Platform owns the GCP project and deploys VMs on behalf of users
- Google OAuth only requests basic scopes (`openid`, `email`) for identity
- Users don't need a GCP account at all
- Simpler, faster onboarding

**Mode B: Bring-Your-Own-GCP (power users / current flow)**
- `GCP_SERVICE_ACCOUNT_KEY` is NOT set
- Google OAuth requests full GCP scopes (compute, service management)
- User selects their own GCP project
- VM deployed to user's own account (existing behavior)

### Three-Tier Model

```
Tier 1: claw.free Platform (Railway)
  ├── Multi-tenant Master Bot (single process, handles all users)
  ├── Web API (existing Hono server, extended)
  ├── PostgreSQL (extended schema)
  └── Platform GCP project (optional, for Mode A deployments)

Tier 2: Reseller (whitelabel)
  ├── Their own Master Bot token (routed through our Railway service)
  ├── Their own branded website (subdomain or custom domain)
  ├── Their own GCP service account (optional, or uses platform's)
  └── Their config (branding, AI provider defaults, limits)

Tier 3: End User
  ├── Their own Telegram bot (deployed to GCP free tier)
  ├── OpenClaw + AI provider (existing flow)
  └── Sandboxed: read-only FS, restricted network
```

### How It Works (End-to-End Flow)

**Mode A (Platform GCP) - The primary flow:**
```
1. User visits claw.free website → sees "Set up your AI bot" with Telegram link
2. User clicks t.me/ClawFreeBot → opens Telegram → sends /start
3. Master bot greets: "I'll help you set up your own AI assistant!"
4. Bot asks: "Which AI provider?" → inline buttons: Claude / ChatGPT / Kimi
5. Bot asks: "Create a bot on @BotFather and send me the token"
6. User pastes token → bot validates via Telegram API (getMe call)
7. Bot sends inline button: "Login with Google" (basic OAuth, just identity)
8. User clicks → browser → Google login (email only) → redirect back
9. Bot detects OAuth complete → "Great, {name}! Deploying your bot..."
10. Bot deploys VM to platform's GCP project using service account
11. Bot edits status message as deployment progresses
12. Once live, user's NEW BOT sends them: "Hi! I'm ready. Let's connect your AI provider..."
13. Master bot confirms: "Your bot @YourBotName is live! Go talk to it."
```

**Mode B (User's GCP) - Fallback / power-user flow:**
```
Steps 1-6: Same as above
7. Bot sends inline button: "Login with Google" (full GCP scopes)
8. User clicks → browser → Google login + GCP permissions → redirect back
9. Bot detects OAuth → asks for GCP project selection (inline buttons)
10. Bot runs preflight → deploys to user's GCP project
11-13: Same as above
```

---

## Environment Variables

```env
# Required
TELEGRAM_BOT_TOKEN=            # The master bot's Telegram token
DATABASE_URL=                  # PostgreSQL connection string
GOOGLE_CLIENT_ID=              # Google OAuth app client ID
GOOGLE_CLIENT_SECRET=          # Google OAuth app secret
BASE_URL=                      # Public URL (e.g., https://claw.free.railway.app)
COOKIE_SECRET=                 # HMAC secret for cookie signing

# Optional - enables Mode A (platform-provided GCP)
GCP_SERVICE_ACCOUNT_KEY=       # JSON key for platform's GCP service account
GCP_PROJECT_ID=                # Platform's GCP project for deploying user VMs
```

When `GCP_SERVICE_ACCOUNT_KEY` is set:
- OAuth scopes: `openid email` only
- Deployment uses platform service account
- No GCP project selection step in bot conversation
- VM naming: `{botname}-{userid}-{random}` under platform project

When `GCP_SERVICE_ACCOUNT_KEY` is NOT set:
- OAuth scopes: `openid email compute service.management cloudplatformprojects.readonly`
- User must select/create their own GCP project
- Existing deploy flow behavior

---

## Implementation Steps

### Phase 1: Master Bot Core (Telegram Bot on Railway)

#### 1.1 New `bot/` directory structure

```
bot/
├── index.ts                  # Bot initialization, webhook handler registration
├── bot.ts                    # grammY bot instance + middleware stack
├── conversations/
│   ├── onboarding.ts         # Main onboarding state machine
│   └── manage.ts             # /mybots - manage existing deployments
├── services/
│   ├── token-validator.ts    # Validate Telegram bot tokens via getMe
│   ├── oauth-bridge.ts       # Generate OAuth links, poll for completion
│   ├── deployer.ts           # Orchestrate GCP deployment (both modes)
│   └── bot-instructor.ts     # Send first message via user's new bot
├── middleware/
│   ├── session.ts            # Per-user conversation state (PostgreSQL)
│   └── whitelabel.ts         # Resolve reseller context from bot token
└── types.ts                  # Shared types
```

#### 1.2 Bot Framework: grammY

**[grammY](https://grammy.dev/)** - TypeScript-first Telegram bot framework.
- Built-in conversation plugin for multi-step flows
- Session middleware with PostgreSQL storage adapter
- Webhook and long-polling support
- Inline keyboard builders
- Excellent TypeScript types

#### 1.3 Conversation State Machine

```
IDLE
  → PROVIDER_SELECT         (inline buttons: Claude / ChatGPT / Kimi)
  → TOKEN_INPUT             ("Paste your @BotFather token")
  → TOKEN_VALIDATED         (bot validates token via getMe)
  → OAUTH_PENDING           (inline button: "Login with Google")
  → OAUTH_COMPLETE          (bot detects OAuth callback)
  → PROJECT_SELECT          (Mode B only: pick GCP project)
  → DEPLOYING               (bot edits status message with progress)
  → INSTRUCTING             (user's new bot sends first message)
  → COMPLETE                ("Your bot is live!")
```

Session state persisted in PostgreSQL - survives Railway restarts.

#### 1.4 Hosting: Webhook on existing Hono server

Integrate into the existing Hono server as a webhook endpoint rather than a separate process:
- `POST /bot/webhook/:secret` - grammY webhook handler
- Shares DB connection, deploy logic, auth infrastructure
- No extra Railway service needed
- Set webhook via `bot.api.setWebhook(BASE_URL + '/bot/webhook/' + secret)`

### Phase 2: OAuth Bridge (Telegram <> Web)

#### 2.1 The Problem

Telegram bots can't do OAuth. User must open a browser, log in, and the bot needs to detect completion.

#### 2.2 Solution

1. Bot generates a unique `state` token, stores in `oauth_bridge_state` table with `telegram_chat_id`
2. Bot sends inline button: **"Login with Google"** → URL: `{BASE_URL}/api/auth/google?bridge_state={token}`
3. Server detects `bridge_state` param → adjusts OAuth scopes based on deployment mode:
   - **Mode A** (GCP_SERVICE_ACCOUNT_KEY set): `openid email`
   - **Mode B** (no service account): full GCP scopes
4. After OAuth callback → server marks `bridge_state` as complete in DB, stores user ID + tokens
5. Bot polls `oauth_bridge_state` table every 2s (up to 10 minutes) until completed
6. Bot resumes conversation with the authenticated user context

#### 2.3 Database Table

```sql
CREATE TABLE oauth_bridge_state (
  state TEXT PRIMARY KEY,
  telegram_chat_id BIGINT NOT NULL,
  telegram_user_id BIGINT NOT NULL,
  reseller_id UUID REFERENCES reseller(id),
  user_id UUID,                          -- Set after OAuth completes
  access_token TEXT,                     -- Set after OAuth completes (Mode B only)
  completed BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ DEFAULT (now() + interval '10 minutes')
);
```

#### 2.4 Modified Auth Flow

- `server/routes/auth-google.ts`: If `bridge_state` param present, store it in session/cookie, adjust scopes based on mode
- `server/routes/auth-callback-google.ts`: If `bridge_state` in session, update `oauth_bridge_state` row with user info, mark `completed = true`, show "You can close this tab" page

### Phase 3: Deployment Integration

#### 3.1 Refactor Deploy Logic into Shared Services

Extract core logic from route handlers into reusable services:

```
server/services/
├── deploy.ts          # createVM(), getDeploymentStatus() - core GCP Compute API calls
├── gcp-projects.ts    # listProjects(), createProject() - project management
└── preflight.ts       # checkProjectReady() - API enablement, permissions
```

Route handlers become thin wrappers. Bot calls services directly.

#### 3.2 Mode A Deployment (Platform GCP)

When `GCP_SERVICE_ACCOUNT_KEY` is set:
- Use service account credentials instead of user's OAuth token
- Deploy to `GCP_PROJECT_ID` (platform's project)
- VM name: `bot-{sanitized-username}-{short-random}`
- Region: auto-select based on user's timezone (from Telegram language_code or default us-central1)
- Skip project selection and preflight (platform project is pre-configured)

#### 3.3 Mode B Deployment (User's GCP)

Existing flow, driven through bot conversation instead of web UI:
- Bot lists user's projects as inline buttons (max 8, with "type manually" option)
- Bot runs preflight, reports issues as messages
- Bot triggers deployment, polls status

#### 3.4 Progress Messages

Bot edits a single "status" message:
```
"⏳ Deploying your bot... Creating VM"
"⏳ Deploying your bot... Booting up"
"⏳ Deploying your bot... Installing AI tools"
"⏳ Deploying your bot... Starting services"
"✅ Your bot @YourBot is live! Go talk to it →"
```

### Phase 4: Bot Instruction (First Message)

Once the user's VM is ready:

1. Master bot uses the user's bot token to call Telegram `sendMessage` API
2. Sends to the user's Telegram ID (known from the master bot conversation)
3. Message: "Hi! I'm your AI assistant. Send /start to begin setup."
4. This triggers the existing bootstrap provider flow on the VM

```typescript
async function instructNewBot(botToken: string, telegramUserId: number) {
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: telegramUserId,
      text: "Hi! I'm your new AI assistant. Send /start to connect your AI provider and start chatting!"
    })
  });
}
```

### Phase 5: Sandbox Hardening (Security)

#### 5.1 Read-Only Filesystem

Modify `infra/nixos/base/default.nix`:
- Root filesystem mounted read-only
- Writable mounts: `/var/lib/openclaw` (workspace), `/tmp` (tmpfs), `/var/log` (logs)
- No package installation possible at runtime

#### 5.2 Restricted Network (Outbound Allowlist)

```nix
networking.firewall = {
  enable = true;
  allowedTCPPorts = [];  # No inbound

  extraCommands = ''
    # AI Provider APIs
    iptables -A OUTPUT -d api.anthropic.com -p tcp --dport 443 -j ACCEPT
    iptables -A OUTPUT -d api.openai.com -p tcp --dport 443 -j ACCEPT
    iptables -A OUTPUT -d api.moonshot.cn -p tcp --dport 443 -j ACCEPT
    # Telegram API
    iptables -A OUTPUT -d api.telegram.org -p tcp --dport 443 -j ACCEPT
    # GCP metadata (for guest attributes / status reporting)
    iptables -A OUTPUT -d metadata.google.internal -j ACCEPT
    # DNS (needed to resolve the above)
    iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
    iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT
    # Loopback
    iptables -A OUTPUT -o lo -j ACCEPT
    # Block everything else
    iptables -A OUTPUT -j DROP
  '';
};
```

### Phase 6: Whitelabel System

#### 6.1 Database Schema

```sql
CREATE TABLE reseller (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,                    -- "Acme AI"
  slug TEXT UNIQUE NOT NULL,             -- "acme-ai"
  master_bot_token TEXT NOT NULL,        -- Their master bot's Telegram token
  webhook_secret TEXT NOT NULL,          -- Unique secret for webhook URL
  website_domain TEXT,                   -- "ai.acme.com" (optional)
  branding JSONB DEFAULT '{}',          -- { logo, colors, welcome_text, bot_greeting }
  default_provider TEXT DEFAULT 'claude',
  max_deployments INT DEFAULT 100,
  owner_user_id UUID REFERENCES "user"(id),

  -- Optional: reseller brings their own GCP
  gcp_service_account_key TEXT,          -- Their own GCP SA key (overrides platform's)
  gcp_project_id TEXT,                   -- Their own GCP project

  -- Optional: reseller brings their own Google OAuth app
  google_client_id TEXT,
  google_client_secret TEXT,

  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE deployment (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reseller_id UUID REFERENCES reseller(id),  -- NULL = platform direct
  user_id UUID REFERENCES "user"(id),
  telegram_user_id BIGINT NOT NULL,
  bot_token_encrypted TEXT NOT NULL,     -- Encrypted bot token
  bot_username TEXT,
  gcp_project_id TEXT NOT NULL,
  gcp_zone TEXT NOT NULL,
  vm_name TEXT NOT NULL,
  status TEXT DEFAULT 'pending',         -- pending, deploying, active, stopped, error
  provider TEXT NOT NULL,                -- claude, openai, kimi
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

#### 6.2 Multi-Bot Webhook Routing

Each reseller's master bot gets a unique webhook URL:

```
POST /bot/webhook/:webhookSecret
```

Middleware resolves `webhookSecret` → reseller context → correct bot instance:

```typescript
// Lookup: webhookSecret → reseller → bot token
// Default (no reseller match) → platform's own master bot
// Each reseller's bot is a separate grammY Bot instance, lazily initialized
```

On startup: register webhooks for platform bot + all active resellers.
On reseller creation: register webhook for new bot.

#### 6.3 Whitelabel Website

**Phase 1**: Resellers get a subdomain: `acme.claw.free`
- Same React app, branding loaded from `GET /api/branding/:slug`
- Returns: name, logo URL, colors, Telegram bot link, custom welcome text

**Phase 2 (later)**: Custom domains via CNAME + Cloudflare for SaaS

#### 6.4 Website Changes

The main claw.free website gets a prominent Telegram bot link:
- Hero section: "Set up your AI assistant in 2 minutes" + **"Open in Telegram"** button
- Button links to `t.me/{botUsername}?start=web` (deep link with referral tracking)
- Existing wizard flow remains available as an alternative path

### Phase 7: Reseller Onboarding

#### 7.1 Flow

1. User signs up on claw.free (existing Google OAuth)
2. Navigates to `/reseller/setup`
3. Creates a master bot via @BotFather, pastes token
4. Configures branding (name, welcome message, default provider)
5. Gets webhook URL to set on their bot
6. Optionally provides their own GCP service account key
7. Gets their Telegram bot link + optional website subdomain

#### 7.2 Dashboard Routes

```
/reseller/dashboard      - Active bots count, recent deployments
/reseller/settings       - Bot token, branding, GCP config
/reseller/deployments    - List/manage end-user deployments
```

---

## File Changes Summary

### New Files
```
bot/
├── index.ts                      # Bot init, webhook registration
├── bot.ts                        # grammY instance + middleware
├── conversations/onboarding.ts   # Onboarding state machine
├── conversations/manage.ts       # /mybots command
├── services/token-validator.ts   # Validate Telegram tokens
├── services/oauth-bridge.ts      # OAuth bridge logic
├── services/deployer.ts          # Deploy orchestration (both modes)
├── services/bot-instructor.ts    # First message via user's bot
├── middleware/session.ts         # PostgreSQL session storage
├── middleware/whitelabel.ts      # Reseller context resolution
└── types.ts                      # Types

server/services/
├── deploy.ts                     # Extracted deploy logic
├── gcp-projects.ts               # Extracted project management
└── preflight.ts                  # Extracted preflight checks

server/routes/
├── bot-webhook.ts                # Webhook endpoint for Hono
└── reseller.ts                   # Reseller CRUD API

src/routes/reseller/
├── dashboard.tsx                 # Reseller dashboard
└── settings.tsx                  # Reseller settings
```

### Modified Files
```
server/index.ts                   # Register webhook + reseller routes
server/db.ts                      # New tables (reseller, deployment, oauth_bridge_state)
server/routes/auth-google.ts      # bridge_state param, dynamic scopes
server/routes/auth-callback-google.ts  # Bridge completion, "close tab" page
infra/nixos/base/default.nix      # Read-only FS + network allowlist
startup-script.sh                 # Sandbox restrictions
package.json                      # Add grammY
src/routes/index.tsx              # Telegram bot link on homepage
```

---

## Implementation Order

| Phase | Description | Effort |
|-------|-------------|--------|
| **1** | Master bot core (grammY + webhook on Hono) | Foundation |
| **2** | OAuth bridge (Telegram ↔ Google login, both modes) | Core |
| **3** | Onboarding conversation (full state machine) | Core |
| **4** | Deploy integration (refactor + bot-driven, Mode A first) | Core |
| **5** | Bot instruction (first message from user's new bot) | Small |
| **6** | Sandbox hardening (read-only FS, network allowlist) | Independent |
| **7** | Whitelabel (multi-bot routing, reseller DB, branding) | Extension |
| **8** | Reseller dashboard + onboarding | Extension |
| **9** | Website update (Telegram link as primary CTA) | Small |

**Start with Phases 1-5** to get a working end-to-end flow. Then Phase 6 for security. Then 7-9 for whitelabel.

---

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Bot framework | grammY | TypeScript-first, conversation plugin, active maintenance |
| Hosting mode | Webhook on existing Hono | Single process, shared DB, no extra Railway service |
| OAuth bridge | State token + DB polling | Simple, reliable, no websocket complexity |
| Default deploy mode | Platform GCP (Mode A) | Lowest friction for end users, one env var to enable |
| Token storage | Encrypted in DB | Bot tokens are sensitive, must not leak |
| Whitelabel routing | Webhook secret per reseller | Each bot gets unique URL, no token in URL |
| Website primary CTA | Telegram deep link | Bot-first experience, website becomes landing page |
