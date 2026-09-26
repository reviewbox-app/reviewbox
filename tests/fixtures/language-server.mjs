// Deterministic protocol fixture: validates UTF-16 negotiation and frozen source.
let pending = Buffer.alloc(0)
let uri
function send(id, result) {
  const body = JSON.stringify({ jsonrpc: "2.0", id, result })
  process.stdout.write(
    `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
  )
}
process.stdin.on("data", (chunk) => {
  pending = Buffer.concat([pending, chunk])
  while (true) {
    const separator = pending.indexOf("\r\n\r\n")
    if (separator < 0) return
    const length = Number(
      /Content-Length: (\d+)/i.exec(
        pending.subarray(0, separator).toString()
      )[1]
    )
    if (pending.length < separator + 4 + length) return
    const message = JSON.parse(
      pending.subarray(separator + 4, separator + 4 + length).toString()
    )
    pending = pending.subarray(separator + 4 + length)
    if (message.method === "initialize") {
      if (message.params.capabilities.general.positionEncodings[0] !== "utf-16")
        process.exit(2)
      send(message.id, {
        capabilities: { definitionProvider: true, positionEncoding: "utf-16" },
      })
    }
    if (message.method === "textDocument/didOpen") {
      if (
        !message.params.textDocument.text.includes("answer = 42") ||
        message.params.textDocument.languageId !== "typescript"
      )
        process.exit(3)
      uri = message.params.textDocument.uri
    }
    if (message.method === "textDocument/definition")
      send(message.id, [
        {
          uri,
          range: {
            start: { line: 0, character: 13 },
            end: { line: 0, character: 19 },
          },
        },
      ])
  }
})
