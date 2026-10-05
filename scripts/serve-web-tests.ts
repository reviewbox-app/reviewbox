import { resolve, sep } from "node:path"

// Serve the exported fixture pages without a development compiler or HMR.
const root = resolve(import.meta.dir, "../out")
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 1423,
  async fetch(request) {
    if (!["GET", "HEAD"].includes(request.method))
      return new Response(null, { status: 405 })
    let pathname: string
    try {
      pathname = decodeURIComponent(new URL(request.url).pathname)
    } catch {
      return new Response(null, { status: 400 })
    }
    const path = resolve(
      root,
      `.${pathname}`,
      ...(pathname.endsWith("/") ? ["index.html"] : [])
    )
    if (!path.startsWith(root + sep)) return new Response(null, { status: 403 })
    const file = Bun.file(path)
    if (!(await file.exists())) return new Response(null, { status: 404 })
    return new Response(request.method === "HEAD" ? null : file, {
      headers: { "Content-Type": file.type, "Cache-Control": "no-store" },
    })
  },
})
console.info(`Web test fixtures: ${server.url}`)
