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
  lastActivity: number
}

const TUNNEL_TIMEOUT_MS = 30_000
const STALE_CONNECTION_MS = 5 * 60_000 // 5 minutes with no activity
const REAPER_INTERVAL_MS = 60_000       // Check every minute

// Active tunnel connections keyed by deploymentId
const tunnels = new Map<string, TunnelConnection>()

export function registerTunnel(deploymentId: string, ws: TunnelSocket): void {
  // Close existing connection if any (reconnect scenario)
  const existing = tunnels.get(deploymentId)
  if (existing) {
    // Reject all pending requests on the old connection
    for (const [, req] of existing.pending) {
      clearTimeout(req.timer)
      req.resolve({ id: "", status: 503, headers: {}, body: "Tunnel reconnecting" })
    }
    existing.pending.clear()
    try { existing.ws.close(1000, "replaced") } catch { /* ignore */ }
  }

  const now = Date.now()
  tunnels.set(deploymentId, {
    deploymentId,
    ws,
    pending: new Map(),
    connectedAt: now,
    lastActivity: now,
  })
}

export function unregisterTunnel(deploymentId: string, ws: TunnelSocket): void {
  const conn = tunnels.get(deploymentId)
  // Only remove if ws matches — prevents a stale close from removing a fresh reconnect
  if (conn && conn.ws === ws) {
    for (const [, req] of conn.pending) {
      clearTimeout(req.timer)
      req.resolve({ id: "", status: 503, headers: {}, body: "Tunnel disconnected" })
    }
    conn.pending.clear()
    tunnels.delete(deploymentId)
  }
}

export function handleTunnelResponse(deploymentId: string, response: TunnelResponse): void {
  const conn = tunnels.get(deploymentId)
  if (!conn) return

  conn.lastActivity = Date.now()

  const pending = conn.pending.get(response.id)
  if (!pending) return

  clearTimeout(pending.timer)
  conn.pending.delete(response.id)
  pending.resolve(response)
}

/**
 * Record activity on a tunnel (e.g. from heartbeat pings).
 */
export function touchTunnel(deploymentId: string): void {
  const conn = tunnels.get(deploymentId)
  if (conn) conn.lastActivity = Date.now()
}

/**
 * Forward an HTTP request through the tunnel to a bot VM.
 * Returns the response from the bot, or an error response if the tunnel is down.
 */
export async function forwardViaTunnel(
  deploymentId: string,
  request: Omit<TunnelRequest, "id">,
): Promise<TunnelResponse> {
  const conn = tunnels.get(deploymentId)
  if (!conn) {
    return { id: "", status: 503, headers: {}, body: "Bot not connected" }
  }

  const id = crypto.randomUUID()
  const message: TunnelRequest = { id, ...request }

  return new Promise<TunnelResponse>((resolve) => {
    const timer = setTimeout(() => {
      // Re-fetch from map to ensure we're modifying the current connection's pending map
      const current = tunnels.get(deploymentId)
      if (current && current.pending.has(id)) {
        current.pending.delete(id)
      }
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

export function getTunnelStats(): {
  total: number
  deployments: Array<{ id: string; connectedAt: number; lastActivity: number; pending: number }>
} {
  const deployments: Array<{ id: string; connectedAt: number; lastActivity: number; pending: number }> = []
  for (const [id, conn] of tunnels) {
    deployments.push({
      id,
      connectedAt: conn.connectedAt,
      lastActivity: conn.lastActivity,
      pending: conn.pending.size,
    })
  }
  return { total: tunnels.size, deployments }
}

/**
 * Reap stale tunnel connections that have had no activity.
 * This handles cases where the WebSocket close event was never received.
 */
function reapStaleConnections(): void {
  const now = Date.now()
  for (const [id, conn] of tunnels) {
    if (now - conn.lastActivity > STALE_CONNECTION_MS) {
      console.log(`Reaping stale tunnel: ${id} (last activity ${Math.round((now - conn.lastActivity) / 1000)}s ago)`)
      for (const [, req] of conn.pending) {
        clearTimeout(req.timer)
        req.resolve({ id: "", status: 503, headers: {}, body: "Tunnel stale" })
      }
      conn.pending.clear()
      try { conn.ws.close(1000, "stale") } catch { /* ignore */ }
      tunnels.delete(id)
    }
  }
}

// Start the reaper on module load
const reaperInterval = setInterval(reapStaleConnections, REAPER_INTERVAL_MS)
reaperInterval.unref() // Don't prevent process exit
