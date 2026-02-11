import type { Context } from "hono"

interface TelegramUpdate {
  message?: {
    from?: { id: number }
  }
}

interface TelegramResponse {
  ok: boolean
  result?: TelegramUpdate[]
}

export async function telegramDetectUser(c: Context): Promise<Response> {
  const { token } = (await c.req.json()) as { token?: string }

  if (!token) {
    return c.json({ error: "Missing token" }, 400)
  }

  const res = await fetch(
    `https://api.telegram.org/bot${token}/getUpdates?limit=10&offset=-10`,
  )

  if (!res.ok) {
    return c.json({ error: "Invalid bot token" }, 400)
  }

  const data = (await res.json()) as TelegramResponse
  if (!data.ok || !data.result?.length) {
    return c.json(
      { error: "No messages found. Send a message to your bot first." },
      404,
    )
  }

  // Get the most recent message's sender
  for (let i = data.result.length - 1; i >= 0; i--) {
    const userId = data.result[i].message?.from?.id
    if (userId) {
      return c.json({ userId: String(userId) })
    }
  }

  return c.json(
    { error: "No messages found. Send a message to your bot first." },
    404,
  )
}
