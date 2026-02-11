# Deploy OpenClaw with claw.free

## Deploy

Welcome! This will deploy OpenClaw to a free-tier GCP VM.

Make sure you're in the correct GCP project using the toolbar above.

<walkthrough-project-setup></walkthrough-project-setup>

Run the deployment script — it will prompt you for your Telegram bot token and user ID:

```bash
bash deploy.sh
```

Once you see **"Deployment Complete"** in the terminal:

1. Open Telegram and message your bot
2. Your bot will guide you through authenticating with your AI provider
3. Start chatting!

If you selected **Claude**: the bot will send you an authentication link. Click it, authorize, then paste the code back in Telegram.

If you selected **ChatGPT**: the bot will send you a verification URL and a code. Go to the URL, enter the code, and the bot will detect when you're done.

If you selected **Kimi K2.5**: no additional auth needed — your NVIDIA API key was set during deployment.

<walkthrough-conclusion-trophy></walkthrough-conclusion-trophy>
