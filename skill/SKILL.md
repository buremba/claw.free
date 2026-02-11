---
name: claw.free
description: Manages your claw.free OpenClaw installation
tools:
  - shell
  - write
---

# claw.free Management

Help the user manage their claw.free OpenClaw deployment. You can:

- **Check status**: Run `bash /var/lib/openclaw/home/.openclaw/skills/claw-free/scripts/status.sh` to show service status, disk/memory usage, and runtime config summary.
- **Update OpenClaw**: Run `bash /var/lib/openclaw/home/.openclaw/skills/claw-free/scripts/update.sh` to upgrade the OpenClaw CLI and restart services.
- **Switch LLM provider**: Run `bash /var/lib/openclaw/home/.openclaw/skills/claw-free/scripts/switch-llm.sh <provider>` where provider is `claude` or `openai`. This re-enables the setup provider and restarts the auth flow.
- **View logs**: Run `journalctl -u openclaw-gateway -n 80 --no-pager` or `journalctl -u claw-free-provider -n 80 --no-pager`.
- **Restart**: Run `systemctl restart claw-free-provider openclaw-gateway`.

When the user asks about their installation, resource usage, or wants to update/change their setup, use the appropriate script or command above.
