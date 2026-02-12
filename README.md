# claw.free

Free OpenClaw installer. Deploy your own AI assistant to the cloud — at zero cost.

**[claw.free](https://claw.free)** is a landing page and automated installer that lets anyone deploy [OpenClaw](https://openclaw.ai) to GCP's always-free tier (e2-micro) with no terminal skills, no Docker knowledge, and no upfront cost.

## How it works

1. Pick your AI provider (Claude or ChatGPT), messaging channel, and cloud region
2. Click "Login with Google" and approve access to your GCP account
3. claw.free provisions OpenClaw to a free VM in your own GCP account via Google APIs
4. Message your bot on Telegram — it walks you through authenticating with your AI provider
5. Done. Chat with your AI assistant 24/7

## Architecture

```
claw.free (web app + API)
  → Google OAuth (compute by default, requests service.management only when API auto-enable is needed)
  → Backend calls GCP APIs to create a private-by-default VM in user's project
      → e2-micro VM (no external IP by default)
      → OpenClaw + Docker
      → claw-free-provider (bootstrap auth flow)
      → Claude Code CLI + Codex CLI
      → claw.free skill (post-setup management)
          → Telegram Bot (user's entry point)
```

**Bring your own cloud.** claw.free doesn't host anything. It deploys into your GCP account. You own the server, data, and configuration. We never see your API keys or cloud credentials.

## Stack

- **Landing page**: TanStack Router, React, Tailwind CSS, shadcn/ui
- **Deploy**: Google OAuth + GCP REST APIs + VM startup scripts
- **VM provisioning**: Nix + Docker on Debian 12
- **Bootstrap provider**: Node.js OpenAI-compatible server for auth flow
- **Hosting**: Cloudflare Pages

## Development

```bash
nix develop        # or: npm install
npm run dev        # process-compose (API: http://localhost:8788, Vite: http://localhost:5365)
npm run build      # production build in dist/
npm run verify     # lint + test + build (recommended before opening/merging PRs)
```

Environment variables used by the API are listed in `.env.example`.
For local development:

```bash
cp .env.example .env
```

Minimum required values for Google login flow:
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `DATABASE_URL` (needed for OAuth callback persistence)
- `COOKIE_SECRET` (required in production; optional in local dev)

`npm run dev` now uses `process-compose` to run both services with hot reload:
- `landing`: Vite dev server (frontend HMR)
- `api`: `tsx watch server/index.ts` (automatic API reload on file changes)
- project-local process manager socket: `.tmp/process-compose.sock` (avoids cross-repo collisions)

Useful process manager commands:
- `npm run dev:status` to list managed processes
- `npm run dev:attach` to attach to the running TUI
- `npm run dev:down` to stop the running process-compose project

If you are not using `nix develop`, install `process-compose` separately (for example `brew install process-compose` on macOS), or use `npm run dev:legacy`.

### Postgres for local dev

Some API routes require Postgres (`DATABASE_URL`). In `NODE_ENV=development` the API boots even if Postgres is down, but DB-backed routes will fail.

### Testing

Recommended loop:
- `npm run dev` for hot reload (Vite + API).
- point `DATABASE_URL` at a real Postgres instance (Railway Postgres, etc.) so you exercise migrations and DB behavior realistically.
- use `npm run verify` before pushing (lint + tests + build).

## Project structure

```
src/                    Landing page (React + TanStack Router)
  routes/               File-based routes
  components/           UI components (selectors, icons, logo)
  lib/                  Wizard state, auth URL builder
server/                 API routes (Google auth + GCP VM provisioning)
provider/               claw-free-provider (bootstrap LLM server)
skill/                  claw.free management skill for OpenClaw
flake.nix               Nix flake for dev environment + VM packages
infra/nixos/base/       NixOS base module + GCP image build for OpenClaw VMs
```

## Lockfiles

This repo intentionally has multiple npm lockfiles:
- root `package-lock.json` for the web app + API
- `infra/nixos/base/ai-tools/package-lock.json` for the pinned CLI bundle baked into the NixOS image
