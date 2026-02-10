---
name: claw.free
description: Manages your claw.free OpenClaw installation
tools:
  - shell
  - write
---

# claw.free Management

Help the user manage their claw.free OpenClaw deployment. You can:

- **Check status**: Run `bash /opt/openclaw/skills/claw-free/scripts/status.sh` to show Docker container status, disk usage, memory, and uptime.
- **Update OpenClaw**: Run `bash /opt/openclaw/skills/claw-free/scripts/update.sh` to pull the latest OpenClaw Docker image and restart.
- **Switch LLM provider**: Run `bash /opt/openclaw/skills/claw-free/scripts/switch-llm.sh <provider>` where provider is `claude` or `openai`. This re-runs the auth flow for the new provider.
- **View logs**: Run `docker logs openclaw --tail 50` to see recent OpenClaw logs.
- **Restart**: Run `cd /opt/openclaw/app && docker compose restart` to restart OpenClaw.

When the user asks about their installation, resource usage, or wants to update/change their setup, use the appropriate script or command above.
