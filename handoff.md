# Handoff: Bot Creation Flow (Railway Provider)

## Goal

Make the full Railway bot creation flow work reliably: API server creates a Railway service, the agent container starts, Telegram webhooks arrive, and the bot responds to messages.

## What's Done

### Code Fixes (working tree, not yet committed)

1. **`infra/agent/Dockerfile`** — `--platform=linux/amd64`, pre-install openclaw globally
2. **`infra/agent/entrypoint.sh`** — `plugins.entries.telegram: { enabled: true }`, auto-generate `OPENCLAW_GATEWAY_TOKEN`, use `openclaw` directly (not npx), `--bind lan`
3. **`server/lib/providers/railway.ts`** — set `OPENCLAW_GATEWAY_TOKEN` and `NODE_OPTIONS=--max-old-space-size=1024` on new services
4. **`server/db.ts`** — `findOrCreateTelegramUser()` includes `username` column, `ensureSchema()` adds `username` migration

### Docker Image

- `buremba/claw-free-agent:latest` pushed to Docker Hub (linux/amd64)
- Contains all entrypoint fixes and pre-installed openclaw

### GitHub Actions

- `.github/workflows/agent-image.yml` — builds and pushes the agent image on push to main (when `infra/agent/`, `skill/`, `package.json` change) or manual dispatch
- **Needs secrets configured:** `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` in the GitHub repo settings

### API Flow

- `POST /api/mini/bots` — auth, Telegram validation, Railway service creation, DB insert, webhook setup all work
- `GET /api/mini/bots` — lists bots
- `DELETE /api/mini/bots/:id` — deletes Railway service + DB record

### Test Tooling

- `scripts/mint-test-token.ts` — creates a test user in DB and mints a Bearer token for API testing

## What's Remaining

### 1. Configure GitHub Actions Secrets

In the GitHub repo settings, add:
- `DOCKERHUB_USERNAME` = `buremba`
- `DOCKERHUB_TOKEN` = Docker Hub access token (generate at https://hub.docker.com/settings/security)

### 2. End-to-End Telegram Test

The agent container now starts correctly on Railway with all fixes, but we haven't confirmed the full Telegram message flow works. Test:

```bash
# Start server
env $(grep -v '^#' .env | grep '=' | while IFS='=' read -r key val; do printf '%s=%s\0' "$key" "$val"; done | xargs -0) PORT=8788 NODE_ENV=development npx tsx watch server/index.ts

# Mint token
npx tsx --env-file=.env scripts/mint-test-token.ts

# Create bot
curl -X POST http://localhost:8788/api/mini/bots \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"botToken":"<bot_token>"}'

# Check webhook is working
curl -s "https://api.telegram.org/bot<bot_token>/getWebhookInfo" | jq .

# Send a message to the bot on Telegram and check Railway logs
```

### 3. Bootstrap Model Provider

The agent config points to `claw-free/setup` model at `http://localhost:3456/v1` which doesn't exist inside the container. The bot should either:
- Respond with a setup prompt guiding users to configure their LLM provider, or
- Have a real setup flow that works without an LLM backend

This needs investigation — the bot may silently fail when trying to call the non-existent model endpoint.

### 4. Webhook Secret Verification

`entrypoint.sh` doesn't currently set `WEBHOOK_SECRET` in the openclaw config. The Railway provider generates a `webhookSecret` and passes it to Telegram's `setWebhook` as `secret_token`, but openclaw needs to verify incoming webhooks against it. Check if openclaw handles this automatically via the `WEBHOOK_SECRET` env var or if config needs updating.

## Issues Found & Fixed

| Issue | Root Cause | Fix |
|-------|-----------|-----|
| `Exec format error` | ARM image on amd64 Railway | `--platform=linux/amd64` |
| OOM crash | Default V8 heap too small | `NODE_OPTIONS=--max-old-space-size=1024` |
| Missing gateway token | openclaw requires auth token | Auto-generated + set by provider |
| Telegram "not enabled" | Missing plugin config | Added `plugins.entries.telegram` |
| Slow container start | npx downloads every restart | Pre-installed in Dockerfile |
| DB `username` NOT NULL | Missing column in schema | Added migration + updated INSERT |

## Key Files

- `infra/agent/Dockerfile` — agent container image
- `infra/agent/entrypoint.sh` — generates openclaw config, starts gateway
- `server/lib/providers/railway.ts` — Railway GraphQL API calls
- `server/routes/mini-bots.ts` — bot CRUD API handlers
- `server/db.ts` — database queries and schema
- `scripts/mint-test-token.ts` — test token minting
- `.github/workflows/agent-image.yml` — CI image build
