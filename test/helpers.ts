/** Tạo fetch giả: mỗi lần gọi trả về một response SSE kế tiếp, và ghi lại request body. */
export function fakeFetch(responses: string[][]) {
  const requests: { url: string; headers: Record<string, string>; body: any }[] = []
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    requests.push({
      url: String(url),
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body)),
    })
    const events = responses[requests.length - 1]
    if (!events) throw new Error('fakeFetch: hết response giả')
    const text = events.map(data => `data: ${data}\n\n`).join('')
    return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch
  return { fetch: fetchImpl, requests }
}

export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = []
  for await (const item of iterable) items.push(item)
  return items
}
