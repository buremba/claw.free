// WebSocket tunnel relay — manages persistent connections from bot VMs.
//
// Bot VMs connect outbound to this relay via WebSocket. When Telegram
// sends a webhook, the relay forwards it through the tunnel to the bot VM.
// No inbound ports, no public IPs, no Tailscale needed.

// Minimal WebSocket interface — compatible with both ws package and Hono's TunnelSocket
export interface TunnelSocket {
  send(data: string): void
  close(code?: number, reason?: string): void
}

interface PendingRequest {
  resolve: (response: TunnelResponse) => void
  timer: ReturnType<typeof setTimeout>
}

export interface TunnelRequest {
  id: string
  method: string
  path: string
  headers: Record<string, string>
  body: string
}

export interface TunnelResponse {
  id: string
  status: number
  headers: Record<string, string>
  body: string
}

interface TunnelConnection {
  deploymentId: string
  ws: TunnelSocket
  pending: Map<string, PendingRequest>
  connectedAt: number
}

const TUNNEL_TIMEOUT_MS = 30_000

// Active tunnel connections keyed by deploymentId
const tunnels = new Map<string, TunnelConnection>()

export function registerTunnel(deploymentId: string, ws: TunnelSocket): void {
  // Close existing connection if any (reconnect scenario)
  const existing = tunnels.get(deploymentId)
  if (existing) {
    try { existing.ws.close(1000, "replaced") } catch { /* ignore */ }
    for (const [, req] of existing.pending) {
      clearTimeout(req.timer)
      req.resolve({ id: "", status: 502, headers: {}, body: "Tunnel replaced" })
    }
  }

  tunnels.set(deploymentId, {
    deploymentId,
    ws,
    pending: new Map(),
    connectedAt: Date.now(),
  })
}

export function unregisterTunnel(deploymentId: string, ws: TunnelSocket): void {
  const conn = tunnels.get(deploymentId)
  if (conn && conn.ws === ws) {
    for (const [, req] of conn.pending) {
      clearTimeout(req.timer)
      req.resolve({ id: "", status: 502, headers: {}, body: "Tunnel disconnected" })
    }
    tunnels.delete(deploymentId)
  }
}

export function handleTunnelResponse(deploymentId: string, response: TunnelResponse): void {
  const conn = tunnels.get(deploymentId)
  if (!conn) return

  const pending = conn.pending.get(response.id)
  if (!pending) return

  clearTimeout(pending.timer)
  conn.pending.delete(response.id)
  pending.resolve(response)
}

/**
 * Forward an HTTP request through the tunnel to a bot VM.
 * Returns the response from the bot, or a 502 if the tunnel is down.
 */
export async function forwardViaTunnel(
  deploymentId: string,
  request: Omit<TunnelRequest, "id">,
): Promise<TunnelResponse> {
  const conn = tunnels.get(deploymentId)
  if (!conn) {
    return { id: "", status: 502, headers: {}, body: "Bot not connected" }
  }

  const id = crypto.randomUUID()
  const message: TunnelRequest = { id, ...request }

  return new Promise<TunnelResponse>((resolve) => {
    const timer = setTimeout(() => {
      conn.pending.delete(id)
      resolve({ id, status: 504, headers: {}, body: "Tunnel timeout" })
    }, TUNNEL_TIMEOUT_MS)

    conn.pending.set(id, { resolve, timer })

    try {
      conn.ws.send(JSON.stringify(message))
    } catch {
      clearTimeout(timer)
      conn.pending.delete(id)
      resolve({ id, status: 502, headers: {}, body: "Tunnel send failed" })
    }
  })
}

export function isTunnelConnected(deploymentId: string): boolean {
  return tunnels.has(deploymentId)
}

export function getTunnelStats(): { total: number; deployments: string[] } {
  return {
    total: tunnels.size,
    deployments: Array.from(tunnels.keys()),
  }
}
