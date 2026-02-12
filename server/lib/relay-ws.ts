// WebSocket upgrade handler for relay tunnels.
// Uses the `ws` package directly on the Node.js HTTP server,
// bypassing Hono's WebSocket adapter (which requires a newer version).

import { WebSocketServer } from "ws"
import { getDeploymentByRelayToken } from "../db.js"
import {
  registerTunnel,
  unregisterTunnel,
  handleTunnelResponse,
  type TunnelResponse,
  type TunnelSocket,
} from "./relay.js"

// Thin TunnelSocket wrapper around the ws WebSocket
function wrapWs(ws: import("ws").WebSocket): TunnelSocket {
  return {
    send(data: string) { ws.send(data) },
    close(code?: number, reason?: string) { ws.close(code, reason) },
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function setupRelayWebSocket(server: any): void {
  const wss = new WebSocketServer({ noServer: true })

  server.on("upgrade", async (req: import("node:http").IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`)

    // Only handle /relay/tunnel upgrades
    if (url.pathname !== "/relay/tunnel") {
      socket.destroy()
      return
    }

    const token = url.searchParams.get("token")
    if (!token) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n")
      socket.destroy()
      return
    }

    // Authenticate
    const deployment = await getDeploymentByRelayToken(token)
    if (!deployment) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n")
      socket.destroy()
      return
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const wrapped = wrapWs(ws)
      const deploymentId = deployment.id

      registerTunnel(deploymentId, wrapped)
      console.log(`Tunnel connected: ${deploymentId}`)

      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString())
          // Ignore heartbeat pings
          if (msg.type === "ping") {
            ws.send(JSON.stringify({ type: "pong" }))
            return
          }
          handleTunnelResponse(deploymentId, msg as TunnelResponse)
        } catch (err) {
          console.error(`Invalid tunnel message from ${deploymentId}:`, err)
        }
      })

      ws.on("close", () => {
        unregisterTunnel(deploymentId, wrapped)
        console.log(`Tunnel disconnected: ${deploymentId}`)
      })

      ws.on("error", () => {
        unregisterTunnel(deploymentId, wrapped)
      })
    })
  })
}
