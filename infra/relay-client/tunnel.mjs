#!/usr/bin/env node
// claw.free relay client — lightweight WebSocket tunnel for bot VMs.
//
// Connects outbound to the Railway relay server. Receives Telegram
// webhook payloads via the tunnel and forwards them to localhost.
//
// Zero external dependencies. Uses Node.js 22 built-in WebSocket.
//
// Env vars (read from GCP metadata or env):
//   RELAY_URL   — Relay server base URL (e.g. https://app.clawfree.dev)
//   RELAY_TOKEN — Per-deployment auth token
//   BOT_PORT    — Local bot port (default: 18789)

const BOT_PORT = process.env.BOT_PORT || "18789"
const BOT_HOST = `http://localhost:${BOT_PORT}`

// Backoff config for reconnection
const MIN_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 30000
const BACKOFF_MULTIPLIER = 2

// Heartbeat interval — keeps connection alive through Railway's proxy (55s idle timeout)
const HEARTBEAT_INTERVAL_MS = 25000

let backoffMs = MIN_BACKOFF_MS
let heartbeatTimer = null
let currentWs = null // Track the active WebSocket to avoid stale references

async function getConfig() {
  // Try env vars first (set directly or via systemd)
  let relayUrl = process.env.RELAY_URL
  let relayToken = process.env.RELAY_TOKEN

  if (relayUrl && relayToken) {
    return { relayUrl, relayToken }
  }

  // Fall back to GCP metadata
  const metaBase = "http://metadata.google.internal/computeMetadata/v1/instance/attributes"
  const headers = { "Metadata-Flavor": "Google" }

  try {
    if (!relayUrl) {
      const res = await fetch(`${metaBase}/RELAY_URL`, { headers, signal: AbortSignal.timeout(2000) })
      if (res.ok) relayUrl = await res.text()
    }
    if (!relayToken) {
      const res = await fetch(`${metaBase}/RELAY_TOKEN`, { headers, signal: AbortSignal.timeout(2000) })
      if (res.ok) relayToken = await res.text()
    }
  } catch {
    // Not on GCP, that's fine
  }

  return { relayUrl, relayToken }
}

async function forwardToBot(request) {
  const url = `${BOT_HOST}${request.path}`
  try {
    const res = await fetch(url, {
      method: request.method,
      headers: request.headers,
      body: request.method !== "GET" && request.method !== "HEAD" ? request.body : undefined,
      signal: AbortSignal.timeout(25000),
    })
    const body = await res.text()
    const headers = {}
    res.headers.forEach((value, key) => { headers[key] = value })

    return {
      id: request.id,
      status: res.status,
      headers,
      body,
    }
  } catch (err) {
    return {
      id: request.id,
      status: 502,
      headers: {},
      body: `Relay client: failed to reach bot at ${url}: ${err.message}`,
    }
  }
}

function clearHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}

function startHeartbeat(ws) {
  clearHeartbeat()
  heartbeatTimer = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: "ping" }))
      } catch {
        // Send failed — close event will handle reconnect
        clearHeartbeat()
      }
    } else {
      // Not open anymore, stop sending heartbeats
      clearHeartbeat()
    }
  }, HEARTBEAT_INTERVAL_MS)
}

function connect(relayUrl, relayToken) {
  const wsUrl = relayUrl.replace(/^http/, "ws") + `/relay/tunnel?token=${relayToken}`
  console.log(`Connecting to relay: ${relayUrl}/relay/tunnel`)

  const ws = new WebSocket(wsUrl)
  currentWs = ws

  ws.addEventListener("open", () => {
    console.log("Tunnel connected")
    backoffMs = MIN_BACKOFF_MS
    startHeartbeat(ws)
  })

  ws.addEventListener("message", async (evt) => {
    let request
    try {
      request = JSON.parse(typeof evt.data === "string" ? evt.data : evt.data.toString())
    } catch {
      console.error("Invalid message from relay:", typeof evt.data === "string" ? evt.data.slice(0, 200) : "[binary]")
      return
    }

    // Ignore pong responses
    if (request.type === "pong") return

    // Forward webhook to local bot
    const response = await forwardToBot(request)

    // Only send response if this is still the active connection
    if (ws === currentWs && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(response))
      } catch {
        console.error("Failed to send response back through tunnel")
      }
    }
  })

  ws.addEventListener("close", (evt) => {
    console.log(`Tunnel closed: code=${evt.code} reason=${evt.reason || "none"}`)
    clearHeartbeat()
    // Only reconnect if this is still the active WebSocket
    if (ws === currentWs) {
      scheduleReconnect(relayUrl, relayToken)
    }
  })

  ws.addEventListener("error", (err) => {
    console.error("Tunnel error:", err.message || err)
    // close event will fire after this, triggering reconnect
  })
}

function scheduleReconnect(relayUrl, relayToken) {
  const jitter = Math.random() * 1000
  const delay = Math.min(backoffMs + jitter, MAX_BACKOFF_MS)
  console.log(`Reconnecting in ${Math.round(delay)}ms...`)
  setTimeout(() => {
    backoffMs = Math.min(backoffMs * BACKOFF_MULTIPLIER, MAX_BACKOFF_MS)
    connect(relayUrl, relayToken)
  }, delay)
}

async function main() {
  const { relayUrl, relayToken } = await getConfig()

  if (!relayUrl || !relayToken) {
    console.log("No RELAY_URL or RELAY_TOKEN configured, relay client not starting.")
    // Exit cleanly — systemd won't restart with exit code 0
    process.exit(0)
  }

  console.log(`Relay client starting (bot at ${BOT_HOST})`)
  connect(relayUrl, relayToken)
}

main().catch((err) => {
  console.error("Fatal:", err)
  process.exit(1)
})
