import { DEPLOY_TIMEOUT_MS } from "./lib/deploy.js"

export interface DeployRecord {
  status: string
  projectId: string
  zone: string
  vmName: string
  botName?: string
  operationName?: string
  accountId: string
  accessToken?: string
  ip?: string
  error?: string
  createdAt?: number
}

const store = new Map<string, DeployRecord>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()

export const deployStore = {
  set(id: string, record: DeployRecord): void {
    store.set(id, record)
    const existing = timers.get(id)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      store.delete(id)
      timers.delete(id)
    }, DEPLOY_TIMEOUT_MS + 60_000)
    timers.set(id, timer)
  },

  get(id: string): DeployRecord | null {
    return store.get(id) ?? null
  },
}
