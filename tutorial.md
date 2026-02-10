# Deploy OpenClaw with claw.free

## Confirm your GCP project

Welcome! This tutorial will deploy OpenClaw to a free-tier GCP VM.

**What you'll get:**
- An always-free e2-micro VM running OpenClaw
- Your Telegram bot connected to your chosen AI model
- Claude Code CLI and Codex CLI pre-installed

Make sure you're in the correct GCP project. You can check and change your project in the Cloud Shell toolbar above.

<walkthrough-project-setup></walkthrough-project-setup>

Click **Next** to continue.

## Deploy OpenClaw

We'll now create your VM and install everything. This takes 3-5 minutes.

Run the deployment script:

```bash
bash deploy.sh
```

The script will:
1. Enable the Compute Engine API
2. Create firewall rules
3. Create an e2-micro VM with all dependencies
4. Wait for the VM to be ready

Click **Next** once the deployment completes.

## You're all set!

Your OpenClaw instance is deployed!

**Next steps:**
1. Open Telegram
2. Find your bot and send any message
3. Your bot will guide you through authenticating with your AI provider
4. Once authenticated, you can start chatting!

If you selected **Claude**: the bot will send you an authentication link. Click it, authorize, then paste the code back in Telegram.

If you selected **ChatGPT**: the bot will send you a verification URL and a code. Go to the URL, enter the code, and the bot will detect when you're done.

<walkthrough-conclusion-trophy></walkthrough-conclusion-trophy>
