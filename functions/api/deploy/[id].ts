interface Env {
  KV: KVNamespace
}

interface DeployRecord {
  status: string
  projectId: string
  zone: string
  vmName: string
  operationName?: string
  sessionId: string
  ip?: string
  error?: string
}

interface GcpOperation {
  status: string
  error?: { errors: { code: string; message: string }[] }
}

interface GcpInstance {
  status: string
  networkInterfaces?: {
    accessConfigs?: { natIP?: string }[]
  }[]
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const deploymentId = (context.params as { id: string }).id
  const data = await context.env.KV.get(`deploy:${deploymentId}`)

  if (!data) {
    return Response.json({ error: "Deployment not found" }, { status: 404 })
  }

  const record = JSON.parse(data) as DeployRecord

  if (record.status === "error") {
    return Response.json({
      status: "error",
      error: record.error,
    })
  }

  if (record.status === "done") {
    return Response.json({
      status: "done",
      ip: record.ip,
    })
  }

  // Check operation status
  if (record.status === "creating" && record.operationName) {
    const sessionData = await context.env.KV.get(
      record.sessionId.startsWith("session:") ? record.sessionId : `session:${record.sessionId}`,
    )
    if (!sessionData) {
      return Response.json({ status: "error", error: "Session expired" })
    }
    const session = JSON.parse(sessionData) as { accessToken: string }
    const headers = { Authorization: `Bearer ${session.accessToken}` }

    const opRes = await fetch(
      `https://compute.googleapis.com/compute/v1/projects/${record.projectId}/zones/${record.zone}/operations/${record.operationName}`,
      { headers },
    )

    if (opRes.ok) {
      const op = (await opRes.json()) as GcpOperation

      if (op.status === "DONE") {
        if (op.error) {
          record.status = "error"
          record.error = op.error.errors.map((e) => e.message).join(", ")
        } else {
          // VM created, fetch IP
          const vmRes = await fetch(
            `https://compute.googleapis.com/compute/v1/projects/${record.projectId}/zones/${record.zone}/instances/${record.vmName}`,
            { headers },
          )

          if (vmRes.ok) {
            const vm = (await vmRes.json()) as GcpInstance
            const ip =
              vm.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP ?? undefined
            record.status = "done"
            record.ip = ip
          } else {
            record.status = "booting"
          }
        }

        await context.env.KV.put(
          `deploy:${deploymentId}`,
          JSON.stringify(record),
          { expirationTtl: 3600 },
        )
      }
    }
  }

  return Response.json({
    status: record.status,
    ip: record.ip,
    error: record.error,
  })
}
