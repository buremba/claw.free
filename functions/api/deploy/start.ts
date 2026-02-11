import { getSessionId } from "../../lib/session"

interface Env {
  KV: KVNamespace
}

interface DeployRequest {
  projectId: string
  telegramToken: string
  region: string
}

interface GcpOperation {
  name: string
  status: string
  targetLink?: string
  error?: { errors: { code: string; message: string }[] }
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const sessionId = getSessionId(context.request)

  if (!sessionId) {
    return Response.json({ error: "Not logged in" }, { status: 401 })
  }

  const body = (await context.request.json()) as DeployRequest
  const { projectId, telegramToken, region } = body

  if (!projectId || !telegramToken || !region) {
    return Response.json(
      { error: "Missing required fields" },
      { status: 400 },
    )
  }

  const sessionData = await context.env.KV.get(`session:${sessionId}`)
  if (!sessionData) {
    return Response.json({ error: "Session expired" }, { status: 400 })
  }

  const session = JSON.parse(sessionData) as {
    provider: string
    channel: string
    accessToken: string
    refreshToken?: string
  }

  const { accessToken, provider } = session
  const zone = `${region}-a`
  const vmName = "openclaw-vm"
  const deploymentId = crypto.randomUUID()

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  }

  // 1. Enable Compute Engine API and wait for it to propagate
  try {
    const enableRes = await fetch(
      `https://serviceusage.googleapis.com/v1/projects/${projectId}/services/compute.googleapis.com:enable`,
      { method: "POST", headers },
    )
    if (enableRes.ok) {
      const op = (await enableRes.json()) as { name?: string; done?: boolean }
      if (op.name && !op.done) {
        for (let i = 0; i < 20; i++) {
          await new Promise((r) => setTimeout(r, 2000))
          const pollRes = await fetch(
            `https://serviceusage.googleapis.com/v1/${op.name}`,
            { headers },
          )
          if (pollRes.ok) {
            const pollData = (await pollRes.json()) as { done?: boolean }
            if (pollData.done) break
          }
        }
      }
    }
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
            { key: "LLM_PROVIDER", value: provider },
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
