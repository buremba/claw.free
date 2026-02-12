// Headscale REST API client
// Used to manage the overlay network: create pre-auth keys for new bot VMs,
// list nodes, and clean up nodes when bots are deleted.

const HEADSCALE_URL = process.env.HEADSCALE_URL ?? ""
const HEADSCALE_API_KEY = process.env.HEADSCALE_API_KEY ?? ""

interface PreAuthKey {
  id: string
  key: string
  user: string
  reusable: boolean
  ephemeral: boolean
  used: boolean
  expiration: string
  createdAt: string
}

interface HeadscaleNode {
  id: string
  name: string
  givenName: string
  user: { name: string }
  ipAddresses: string[]
  online: boolean
}

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${HEADSCALE_API_KEY}`,
    "Content-Type": "application/json",
  }
}

function apiUrl(path: string): string {
  return `${HEADSCALE_URL}${path}`
}

/**
 * Create a single-use, ephemeral pre-auth key for a new bot VM.
 * The key expires in 1 hour (plenty of time for VM boot + Tailscale join).
 * Ephemeral = node auto-deletes from Headscale when it goes offline for 30min.
 */
export async function createBotPreAuthKey(): Promise<string> {
  const expiration = new Date(Date.now() + 60 * 60 * 1000).toISOString()
  const res = await fetch(apiUrl("/api/v1/preauthkey"), {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      user: "bots",
      reusable: false,
      ephemeral: true,
      expiration,
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Headscale: failed to create pre-auth key: ${res.status} ${body}`)
  }

  const data = (await res.json()) as { preAuthKey: PreAuthKey }
  return data.preAuthKey.key
}

/**
 * Find a node by hostname in the overlay network.
 * Returns the node's overlay IP addresses and ID.
 */
export async function findNodeByHostname(
  hostname: string,
): Promise<{ nodeId: string; overlayIp: string } | null> {
  const res = await fetch(apiUrl("/api/v1/node"), {
    method: "GET",
    headers: headers(),
  })

  if (!res.ok) return null

  const data = (await res.json()) as { nodes: HeadscaleNode[] }
  const node = data.nodes.find(
    (n) => n.givenName === hostname || n.name === hostname,
  )

  if (!node || node.ipAddresses.length === 0) return null

  // Prefer IPv4 (100.64.x.x) over IPv6
  const ipv4 = node.ipAddresses.find((ip) => ip.startsWith("100."))
  return {
    nodeId: node.id,
    overlayIp: ipv4 ?? node.ipAddresses[0],
  }
}

/**
 * Delete a node from the overlay network.
 * Called when a bot deployment is deleted.
 */
export async function deleteNode(nodeId: string): Promise<void> {
  const res = await fetch(apiUrl(`/api/v1/node/${nodeId}`), {
    method: "DELETE",
    headers: headers(),
  })

  if (!res.ok && res.status !== 404) {
    const body = await res.text()
    throw new Error(`Headscale: failed to delete node ${nodeId}: ${res.status} ${body}`)
  }
}

/**
 * List all bot nodes in the overlay network.
 */
export async function listBotNodes(): Promise<HeadscaleNode[]> {
  const res = await fetch(apiUrl("/api/v1/node?user=bots"), {
    method: "GET",
    headers: headers(),
  })

  if (!res.ok) return []

  const data = (await res.json()) as { nodes: HeadscaleNode[] }
  return data.nodes
}

/**
 * Check if Headscale is configured and reachable.
 */
export function isHeadscaleConfigured(): boolean {
  return HEADSCALE_URL.length > 0 && HEADSCALE_API_KEY.length > 0
}
