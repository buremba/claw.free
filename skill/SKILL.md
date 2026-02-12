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
- **Add a new AI provider**: Run `bash /var/lib/openclaw/home/.openclaw/skills/claw-free/scripts/switch-llm.sh <provider>` where provider is `claude`, `openai`, or `kimi`. This temporarily switches to the setup flow so the user can authenticate with the new provider. After auth completes, the new provider is added as a fallback model.
- **Switch primary AI provider**: Same as above — after the user completes auth for the new provider, it becomes the primary model and the previous one becomes a fallback.
- **View logs**: Run `journalctl -u openclaw-gateway -n 80 --no-pager` or `journalctl -u claw-free-provider -n 80 --no-pager`.
- **Restart**: Run `systemctl restart claw-free-provider openclaw-gateway`.

When the user asks about their installation, resource usage, or wants to update/change their setup, use the appropriate script or command above.

## Important

The claw-free model provider stays running as a fallback after initial setup. It provides a management interface accessible when the claw-free/setup model is active. Users don't need to interact with it directly — use the scripts above instead.
