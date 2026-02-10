# claw.free

Free OpenClaw installer. Deploy your own AI assistant to the cloud — at zero cost.

**[claw.free](https://claw.free)** is a landing page and automated installer that lets anyone deploy [OpenClaw](https://openclaw.ai) to GCP's always-free tier (e2-micro) with no terminal skills, no Docker knowledge, and no upfront cost.

## How it works

1. Pick your AI provider (Claude or ChatGPT), messaging channel, and cloud region
2. Click "Login with Google" — opens Google Cloud Shell
3. Cloud Shell deploys OpenClaw to a free VM in your own GCP account
4. Message your bot on Telegram — it walks you through authenticating with your AI provider
5. Done. Chat with your AI assistant 24/7

## Architecture

```
claw.free (static landing page)
  → generates "Open in Cloud Shell" URL
  → GCP Cloud Shell deploys to user's e2-micro VM
      → OpenClaw + Docker
      → claw-free-provider (bootstrap auth flow)
      → Claude Code CLI + Codex CLI
      → claw.free skill (post-setup management)
          → Telegram Bot (user's entry point)
```

**Bring your own cloud.** claw.free doesn't host anything. It deploys into your GCP account. You own the server, data, and configuration. We never see your API keys or cloud credentials.

## Stack

- **Landing page**: TanStack Router, React, Tailwind CSS, shadcn/ui
- **Deploy**: GCP Cloud Shell tutorial + bash scripts
- **VM provisioning**: Nix + Docker on Debian 12
- **Bootstrap provider**: Node.js OpenAI-compatible server for auth flow
- **Hosting**: Cloudflare Pages

## Development

```bash
nix develop        # or: npm install
npm run dev        # http://localhost:5365
npm run build      # production build in dist/
```

## Project structure

```
src/                    Landing page (React + TanStack Router)
  routes/               File-based routes
  components/           UI components (selectors, icons, logo)
  lib/                  Wizard state, Cloud Shell URL builder
provider/               claw-free-provider (bootstrap LLM server)
skill/                  claw.free management skill for OpenClaw
deploy.sh               GCP Cloud Shell deploy script
startup-script.sh       VM startup script (Nix + Docker + OpenClaw)
tutorial.md             Cloud Shell guided tutorial
flake.nix               Nix flake for dev environment + VM packages
```
