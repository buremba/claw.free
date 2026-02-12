// WebSocket upgrade handler for relay tunnels.
// Uses the `ws` package directly on the Node.js HTTP server,
// bypassing Hono's WebSocket adapter (which requires a newer version).

import { WebSocketServer } from "ws"
import type { RawData, WebSocket } from "ws"
import { getDeploymentByRelayToken } from "../db.js"
import {
  registerTunnel,
  unregisterTunnel,
  handleTunnelResponse,
  touchTunnel,
  type TunnelResponse,
  type TunnelSocket,
} from "./relay.js"

// Thin TunnelSocket wrapper around the ws WebSocket
function wrapWs(ws: WebSocket): TunnelSocket {
  return {
    send(data: string) { ws.send(data) },
    close(code?: number, reason?: string) { ws.close(code, reason) },
  }
}

/**
 * Validate that a parsed message has the shape of a TunnelResponse.
 */
function isValidTunnelResponse(msg: unknown): msg is TunnelResponse {
  if (typeof msg !== "object" || msg === null) return false
  const obj = msg as Record<string, unknown>
  return (
    typeof obj.id === "string" &&
    typeof obj.status === "number" &&
    typeof obj.headers === "object" && obj.headers !== null &&
    typeof obj.body === "string"
  )
}

// Max WebSocket message size (1 MB) — prevents memory exhaustion from oversized payloads
const MAX_MESSAGE_SIZE = 1024 * 1024

export function setupRelayWebSocket(server: import("node:http").Server): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_SIZE })

  server.on("upgrade", async (req: import("node:http").IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => {
    try {
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

      // Authenticate — wrap DB call to prevent unhandled rejection on pool errors
      let deployment
      try {
        deployment = await getDeploymentByRelayToken(token)
      } catch (err) {
        console.error("Relay tunnel auth DB error:", err)
        socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n")
        socket.destroy()
        return
      }
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

        ws.on("message", (data: RawData) => {
          try {
            const msg = JSON.parse(data.toString()) as Record<string, unknown>

            // Handle heartbeat pings
            if (msg.type === "ping") {
              touchTunnel(deploymentId)
              ws.send(JSON.stringify({ type: "pong" }))
              return
            }

            // Validate response structure before processing
            if (!isValidTunnelResponse(msg)) {
              console.error(`Malformed tunnel response from ${deploymentId}:`, JSON.stringify(msg).slice(0, 200))
              return
            }

            handleTunnelResponse(deploymentId, msg)
          } catch (err: unknown) {
            console.error(`Invalid tunnel message from ${deploymentId}:`, err)
          }
        })

        ws.on("close", () => {
          unregisterTunnel(deploymentId, wrapped)
          console.log(`Tunnel disconnected: ${deploymentId}`)
        })

        ws.on("error", (err: Error) => {
          console.error(`Tunnel WebSocket error for ${deploymentId}:`, err)
          unregisterTunnel(deploymentId, wrapped)
        })
      })
    } catch (err) {
      console.error("Relay WebSocket upgrade error:", err)
      try { socket.destroy() } catch { /* ignore */ }
    }
  })
}
