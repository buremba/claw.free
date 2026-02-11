# Deploy OpenClaw with claw.free

## Set up and deploy

Welcome! This tutorial will deploy OpenClaw to a free-tier GCP VM.

**What you'll get:**
- An always-free e2-micro VM running OpenClaw
- Your Telegram bot connected to your chosen AI model
- Claude Code CLI and Codex CLI pre-installed

Make sure you're in the correct GCP project. You can check and change your project in the Cloud Shell toolbar above.

<walkthrough-project-setup></walkthrough-project-setup>

Now run the deployment script. It will prompt you for your Telegram bot token and user ID.

```bash
bash deploy.sh
```

The script will:
1. Ask for your Telegram bot token and user ID
2. Enable the Compute Engine API
3. Create firewall rules
4. Create an e2-micro VM with all dependencies
5. Wait for everything to be ready

**Wait until you see "Deployment Complete" in the terminal before clicking Next.**

## You're all set!

Your OpenClaw instance is deployed!

**Next steps:**
1. Open Telegram
2. Find your bot and send any message
3. Your bot will guide you through authenticating with your AI provider
4. Once authenticated, you can start chatting!

If you selected **Claude**: the bot will send you an authentication link. Click it, authorize, then paste the code back in Telegram.

If you selected **ChatGPT**: the bot will send you a verification URL and a code. Go to the URL, enter the code, and the bot will detect when you're done.

If you selected **Kimi K2.5**: no additional auth needed — your NVIDIA API key was set during deployment.

<walkthrough-conclusion-trophy></walkthrough-conclusion-trophy>
