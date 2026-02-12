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
import { deployCreateProject } from "./routes/deploy-create-project.js"
import { deployExisting } from "./routes/deploy-existing.js"
import { telegramDetectUser } from "./routes/telegram-detect-user.js"

const app = new Hono()
const distRoot = fileURLToPath(new URL("../dist", import.meta.url))
const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]

function buildProxyHeaders(input: Headers): Headers {
  const headers = new Headers(input)
  for (const header of HOP_BY_HOP_HEADERS) {
    headers.delete(header)
  }
  return headers
}

// --- API routes ---
app.on(["GET", "HEAD"], "/healthz", (c) => {
  if (c.req.method === "HEAD") {
    return c.body(null, 200)
  }
  return c.text("ok")
})
app.get("/api/auth/google", authGoogle)
app.get("/api/auth/callback/google", authCallbackGoogle)
app.get("/api/auth/logout", authLogout)
app.get("/api/deploy/session", deploySession)
app.get("/api/deploy/projects", deployProjects)
app.post("/api/deploy/preflight", deployPreflight)
app.post("/api/deploy/start", deployStart)
app.get("/api/deploy/:id", deployStatus)
app.post("/api/deploy/create-project", deployCreateProject)
app.get("/api/deploy/existing", deployExisting)
app.post("/api/telegram/detect-user", telegramDetectUser)

const isDev = process.env.NODE_ENV === "development"

if (isDev) {
  // In dev, proxy non-API requests to Vite dev server
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
      return new Response(res.body, {
        status: res.status,
        headers: res.headers,
      })
    } catch (error) {
      console.error("Dev proxy request failed:", error)
      return c.text("Dev proxy failed to reach Vite server", 502)
    }
  })
} else {
  if (!existsSync(distRoot)) {
    console.warn(`Static asset directory not found: ${distRoot}`)
  }
  console.log(`Serving static files from ${distRoot}`)
  // In production, serve static files from dist/
  app.use("*", serveStatic({ root: distRoot }))
  // SPA fallback — serve index.html for non-file routes
  app.use("*", serveStatic({ root: distRoot, path: "/index.html" }))
}

const port = Number(process.env.PORT ?? 8788)
console.log(`Server starting on port ${port}`)
serve({ fetch: app.fetch, port })
