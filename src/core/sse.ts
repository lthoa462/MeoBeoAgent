// Đọc Server-Sent Events từ một fetch Response.
// Cả OpenAI và Gemini đều stream theo dạng:  data: {...json...}\n\n

export async function* readSse(response: Response): AsyncGenerator<string> {
  if (!response.body) return
  const decoder = new TextDecoder()
  let buffer = ''
  let dataLines: string[] = []

  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true })
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, '')
      buffer = buffer.slice(newline + 1)
      if (line === '') {
        // Dòng trống kết thúc một event.
        if (dataLines.length) yield dataLines.join('\n')
        dataLines = []
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart())
      }
      // Bỏ qua các trường khác (event:, id:, comment ":").
    }
  }
  buffer += decoder.decode()
  if (buffer.startsWith('data:')) dataLines.push(buffer.slice(5).trimStart())
  if (dataLines.length) yield dataLines.join('\n')
}
