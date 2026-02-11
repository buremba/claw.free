# claw.free NixOS Base

This directory contains the first declarative NixOS base for claw.free managed OpenClaw VMs.

## What it configures

- `openclaw-setup.service`
  - Reads VM metadata (`TELEGRAM_TOKEN`, `LLM_PROVIDER`, `BOT_NAME`)
  - Creates runtime directories under `/var/lib/openclaw`
  - Installs `openclaw` CLI into `/var/lib/openclaw/npm-global`
  - Writes `/var/lib/openclaw/home/.openclaw/openclaw.json`
- `claw-free-provider.service`
  - Runs the local bootstrap provider on port `3456`
- `openclaw-gateway.service`
  - Runs native OpenClaw gateway on port `18789`
- `openclaw-ai-tools.service`
  - Installs Claude/Codex/Gemini CLIs asynchronously

## Build GCP Image

From this directory:

```bash
nix build .#gcp-image
```

Then upload the produced image artifact to your GCP image family.
