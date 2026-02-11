export const onRequestGet: PagesFunction = async (context) => {
  const url = new URL(context.request.url)
  const secure = url.origin.startsWith("https://") ? "; Secure" : ""

  return new Response(null, {
    status: 302,
    headers: {
      Location: url.origin + "/",
      "Set-Cookie": `session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`,
    },
  })
}
