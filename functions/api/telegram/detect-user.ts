interface TelegramUpdate {
  message?: {
    from?: { id: number }
  }
}

interface TelegramResponse {
  ok: boolean
  result?: TelegramUpdate[]
}

export const onRequestPost: PagesFunction = async (context) => {
  const { token } = (await context.request.json()) as { token?: string }

  if (!token) {
    return Response.json({ error: "Missing token" }, { status: 400 })
  }

  const res = await fetch(
    `https://api.telegram.org/bot${token}/getUpdates?limit=10&offset=-10`,
  )

  if (!res.ok) {
    return Response.json({ error: "Invalid bot token" }, { status: 400 })
  }

  const data = (await res.json()) as TelegramResponse
  if (!data.ok || !data.result?.length) {
    return Response.json({ error: "No messages found. Send a message to your bot first." }, { status: 404 })
  }

  // Get the most recent message's sender
  for (let i = data.result.length - 1; i >= 0; i--) {
    const userId = data.result[i].message?.from?.id
    if (userId) {
      return Response.json({ userId: String(userId) })
    }
  }

  return Response.json({ error: "No messages found. Send a message to your bot first." }, { status: 404 })
}
