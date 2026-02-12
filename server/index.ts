import { Hono } from "hono"
import { serve } from "@hono/node-server"
import { serveStatic } from "@hono/node-server/serve-static"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { authGoogle } from "./routes/auth-google.js"
import { authCallbackGoogle } from "./routes/auth-callback-google.js"
import { authLogout } from "./routes/auth-logout.js"
import { deploySession } from "./routes/deploy-session.js"
import { deployProjects } from "./routes/deploy-projects.js"
import { deployStart } from "./routes/deploy-start.js"
import { deployStatus } from "./routes/deploy-status.js"
import { deployPreflight } from "./routes/deploy-preflight.js"
import { deployExisting } from "./routes/deploy-existing.js"
import { telegramDetectUser } from "./routes/telegram-detect-user.js"
import { miniAuth } from "./routes/mini-auth.js"
import { miniListBots, miniGetBot, miniCreateBot, miniDeleteBot, miniValidateToken } from "./routes/mini-bots.js"
import { internalAllowlist } from "./routes/internal-allowlist.js"
import { relayWebhook, relayStatus } from "./routes/relay.js"
import { setupRelayWebSocket } from "./lib/relay-ws.js"
import { rateLimit } from "./lib/rate-limit.js"
import { ensureSchema } from "./db.js"

const app = new Hono()
const distRoot = fileURLToPath(new URL("../dist", import.meta.url))
const HOP_BY_HOP_HEADERS = [
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
]

function buildProxyHeaders(input: Headers): Headers {
  const headers = new Headers(input)
  for (const header of HOP_BY_HOP_HEADERS) headers.delete(header)
  return headers
}

// --- Security headers ---
app.use("*", async (c, next) => {
  await next()
  c.header("X-Content-Type-Options", "nosniff")
  c.header("X-Frame-Options", "DENY")
  c.header("Referrer-Policy", "strict-origin-when-cross-origin")
})

// --- Health check ---
app.on(["GET", "HEAD"], "/healthz", (c) => {
  if (c.req.method === "HEAD") return c.body(null, 200)
  return c.text("ok")
})

// --- Google OAuth + Web Deploy routes (existing) ---
app.get("/api/auth/google", authGoogle)
app.get("/api/auth/callback/google", authCallbackGoogle)
app.get("/api/auth/logout", authLogout)
app.get("/api/deploy/session", deploySession)
app.get("/api/deploy/projects", deployProjects)
app.post("/api/deploy/preflight", deployPreflight)
app.post("/api/deploy/start", deployStart)
app.get("/api/deploy/:id", deployStatus)
app.get("/api/deploy/existing", deployExisting)
app.post("/api/telegram/detect-user", telegramDetectUser)

// --- Mini App routes (Telegram) ---
app.post("/api/mini/auth", rateLimit(30, 60_000), miniAuth)
app.get("/api/mini/bots", miniListBots)
app.post("/api/mini/bots", rateLimit(6, 600_000), miniCreateBot)
app.get("/api/mini/bots/:id", miniGetBot)
app.delete("/api/mini/bots/:id", miniDeleteBot)
app.post("/api/mini/validate-token", rateLimit(10, 60_000), miniValidateToken)

// --- Internal routes (gateway → API, authenticated via X-Internal-Key) ---
app.get("/api/internal/allowlist", internalAllowlist)

// --- Relay tunnel routes (Railway-native bot VM connectivity) ---
// WebSocket upgrade handled separately on the HTTP server (see below).
// These are the HTTP endpoints for webhook forwarding and status.
app.post("/relay/hook/:deploymentId", relayWebhook)
app.get("/relay/status", relayStatus)

// --- Static files & dev proxy ---
const isDev = process.env.NODE_ENV === "development"

if (isDev) {
  app.all("*", async (c) => {
    const url = new URL(c.req.url)
    const target = `http://localhost:5365${url.pathname}${url.search}`
    const init: RequestInit & { duplex?: string } = {
      method: c.req.method,
      headers: buildProxyHeaders(c.req.raw.headers),
    }
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      init.body = c.req.raw.body
      init.duplex = "half"
    }
    try {
      const res = await fetch(target, init)
      return new Response(res.body, { status: res.status, headers: res.headers })
    } catch {
      return c.text("Dev proxy failed to reach Vite server", 502)
    }
  })
} else {
  if (!existsSync(distRoot)) {
    console.warn(`Static asset directory not found: ${distRoot}`)
  }
  console.log(`Serving static files from ${distRoot}`)
  app.use("*", serveStatic({ root: distRoot }))
  app.use("*", serveStatic({ root: distRoot, path: "/index.html" }))
}

// --- Global error handlers ---
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection:", reason)
})

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err)
  process.exit(1)
})

// --- Start server ---
async function main(): Promise<void> {
  try {
    await ensureSchema()
    console.log("DB schema ensured")
  } catch (err) {
    console.error("DB schema migration failed:", err)
    if (process.env.NODE_ENV === "production") {
      process.exit(1)
    }
    console.warn("Continuing without ensured DB schema (development mode).")
  }

  const port = Number(process.env.PORT ?? 8788)
  console.log(`Server starting on port ${port}`)
  const server = serve({ fetch: app.fetch, port })

  // Attach WebSocket upgrade handler for relay tunnels.
  // Handles: GET /relay/tunnel?token=<relay_token> → WebSocket upgrade
  setupRelayWebSocket(server)
}

main().catch((err) => {
  console.error("Fatal server startup error:", err)
  process.exit(1)
})
