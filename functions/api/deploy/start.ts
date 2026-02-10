interface Env {
  KV: KVNamespace
}

interface DeployRequest {
  sessionId: string
  projectId: string
  telegramToken: string
  telegramUserId: string
}

interface GcpOperation {
  name: string
  status: string
  targetLink?: string
  error?: { errors: { code: string; message: string }[] }
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const body = (await context.request.json()) as DeployRequest
  const { sessionId, projectId, telegramToken, telegramUserId } = body

  if (!sessionId || !projectId || !telegramToken || !telegramUserId) {
    return Response.json(
      { error: "Missing required fields" },
      { status: 400 },
    )
  }

  const sessionData = await context.env.KV.get(sessionId.startsWith("session:") ? sessionId : `session:${sessionId}`)
  if (!sessionData) {
    return Response.json({ error: "Session expired" }, { status: 400 })
  }

  const session = JSON.parse(sessionData) as {
    provider: string
    channel: string
    region: string
    accessToken: string
    refreshToken?: string
    nvidiaApiKey?: string
  }

  const { accessToken, region, provider } = session
  const zone = `${region}-a`
  const vmName = "openclaw-vm"
  const deploymentId = crypto.randomUUID()

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  }

  // 1. Enable Compute Engine API
  try {
    await fetch(
      `https://serviceusage.googleapis.com/v1/projects/${projectId}/services/compute.googleapis.com:enable`,
      { method: "POST", headers },
    )
  } catch {
    // May already be enabled
  }

  // 2. Create firewall rule (ignore if exists)
  try {
    await fetch(
      `https://compute.googleapis.com/compute/v1/projects/${projectId}/global/firewalls`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: "openclaw-allow-api",
          allowed: [{ IPProtocol: "tcp", ports: ["18789"] }],
          targetTags: ["openclaw"],
          sourceRanges: ["0.0.0.0/0"],
          description: "Allow OpenClaw API traffic",
        }),
      },
    )
  } catch {
    // May already exist
  }

  // 3. Create VM
  const startupScriptUrl =
    "https://raw.githubusercontent.com/buremba/claw-free-deploy/main/startup-script.sh"

  const vmRes = await fetch(
    `https://compute.googleapis.com/compute/v1/projects/${projectId}/zones/${zone}/instances`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: vmName,
        machineType: `zones/${zone}/machineTypes/e2-micro`,
        disks: [
          {
            boot: true,
            autoDelete: true,
            initializeParams: {
              sourceImage:
                "projects/debian-cloud/global/images/family/debian-12",
              diskSizeGb: "30",
              diskType: `zones/${zone}/diskTypes/pd-standard`,
            },
          },
        ],
        networkInterfaces: [
          {
            network: "global/networks/default",
            accessConfigs: [
              { type: "ONE_TO_ONE_NAT", name: "External NAT" },
            ],
          },
        ],
        tags: { items: ["openclaw"] },
        metadata: {
          items: [
            { key: "startup-script-url", value: startupScriptUrl },
            { key: "TELEGRAM_TOKEN", value: telegramToken },
            { key: "TELEGRAM_USER_ID", value: telegramUserId },
            { key: "LLM_PROVIDER", value: provider },
            ...(provider === "kimi"
              ? [
                  { key: "NVIDIA_API_KEY", value: session.nvidiaApiKey ?? "" },
                  { key: "LLM_BASE_URL", value: "https://integrate.api.nvidia.com/v1/chat/completions" },
                  { key: "LLM_MODEL_ID", value: "moonshotai/kimi-k2.5" },
                ]
              : []),
          ],
        },
      }),
    },
  )

  if (!vmRes.ok) {
    const err = await vmRes.text()
    await context.env.KV.put(
      `deploy:${deploymentId}`,
      JSON.stringify({ status: "error", error: err, projectId, zone, vmName }),
      { expirationTtl: 3600 },
    )
    return Response.json({ deploymentId, error: err }, { status: 500 })
  }

  const operation = (await vmRes.json()) as GcpOperation

  await context.env.KV.put(
    `deploy:${deploymentId}`,
    JSON.stringify({
      status: "creating",
      projectId,
      zone,
      vmName,
      operationName: operation.name,
      sessionId,
    }),
    { expirationTtl: 3600 },
  )

  return Response.json({ deploymentId })
}
