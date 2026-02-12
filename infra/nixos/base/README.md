# claw.free NixOS Base

This directory contains the first declarative NixOS base for claw.free managed OpenClaw VMs.

## What it configures

- `openclaw-setup.service`
  - Reads VM metadata:
    - `TELEGRAM_TOKEN`
    - `LLM_PROVIDER` (optional fallback to module default)
    - `GATEWAY_TOKEN` (optional; generated per-VM if missing)
  - Creates runtime directories under `/var/lib/openclaw`
  - Writes `/var/lib/openclaw/home/.openclaw/openclaw.json`
- `claw-free-provider.service`
  - Runs the local bootstrap provider on port `3456`
- `openclaw-gateway.service`
  - Runs native OpenClaw gateway on port `18789`
- `openclaw-relay.service`
  - Optional WebSocket tunnel client (used for GCP agents) that connects outbound to the relay server
  - Reads VM metadata: `RELAY_URL`, `RELAY_TOKEN`
- `openclaw-gateway-ready.service`
  - Publishes guest-attribute `openclaw/setup=ready` only after the gateway is actually reachable
- AI CLIs (OpenClaw/Claude/Codex/Gemini)
  - Installed declaratively via a pinned Nix package bundle
  - No runtime npm install during VM boot

## Build GCP Image

From this directory:

```bash
nix build .#gcp-image
```

Then upload the produced image artifact to your GCP image family.

## Update pinned CLI versions

```bash
cd infra/nixos/base/ai-tools
npm install --save-exact openclaw@<version> @anthropic-ai/claude-code@<version> @openai/codex@<version> @google/gemini-cli@<version>
```

After updating `package-lock.json`, refresh `npmDepsHash` in `infra/nixos/base/default.nix` by running:

```bash
nix run nixpkgs#prefetch-npm-deps -- package-lock.json
```
