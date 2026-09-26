import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import assert from "node:assert/strict"
import type { Workspace } from "../src/lib/desktop/contracts.generated"
const directory = await mkdtemp(join(tmpdir(), "reviewbox-cli-"))
const repo = join(directory, "repo")
const binary = resolve("src-tauri/target/debug/reviewbox")
const env = {
  ...process.env,
  REVIEWBOX_VALIDATION_DATA: join(directory, "app"),
}
async function run(args: string[], cwd = repo) {
  const child = Bun.spawn(args, { cwd, env, stdout: "pipe", stderr: "pipe" })
  const [output, error] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  assert.equal(await child.exited, 0, error)
  return output
}
try {
  await mkdir(repo)
  await run(["git", "init", "-q"])
  await run(["git", "config", "user.name", "CLI fixture"])
  await run(["git", "config", "user.email", "fixture@example.invalid"])
  await writeFile(join(repo, "a.ts"), "export const answer = 1;\n")
  await run(["git", "add", "."])
  await run(["git", "commit", "-qm", "base"])
  await writeFile(join(repo, "a.ts"), "export const answer = 2;\n")
  const workspace: Workspace = JSON.parse(
    await run([binary, "create", "--repo", repo])
  )
  const change = workspace.snapshot.changes[0]
  const anchor = {
    snapshotId: workspace.snapshot.id,
    changeId: change.id,
    passageId: change.passages[0].id,
  }
  const input = join(directory, "comment.json")
  await writeFile(
    input,
    JSON.stringify({
      reviewId: workspace.review.id,
      snapshotId: workspace.snapshot.id,
      anchor,
      body: "Created without the desktop app",
      question: true,
    })
  )
  const review = JSON.parse(
    await run([binary, "annotate", "--repo", repo, "--from", input])
  )
  assert.equal(review.annotations.length, 1)
  assert.equal(review.annotations[0].author, "agent:external")
  assert.equal(review.decisions.length, 0)
  await writeFile(
    input,
    JSON.stringify({
      reviewId: workspace.review.id,
      snapshotId: workspace.snapshot.id,
      content: {
        kind: "explanation",
        path: "a.ts",
        sections: [
          {
            id: "section",
            title: "Answer",
            body: "A shared explanation",
            startLine: 1,
            endLine: 1,
          },
        ],
      },
    })
  )
  await run([binary, "enrich", "--repo", repo, "--from", input])
  await writeFile(
    input,
    JSON.stringify({
      content: {
        title: "Read this project",
        steps: [
          {
            id: "first",
            title: "Answer",
            explanation: "Start here",
            path: "a.ts",
            startLine: 1,
            endLine: 1,
            quote: "",
            fingerprint: "",
            visited: false,
          },
        ],
      },
    })
  )
  const tour = JSON.parse(
    await run([binary, "tour", "--repo", repo, "--from", input])
  )
  assert.equal(tour.steps[0].quote, "export const answer = 2;\n")
  const context = JSON.parse(await run([binary, "context", "--repo", repo]))
  assert.equal(context.reviewId, workspace.review.id)
  const shared = JSON.parse(
    await readFile(
      join(repo, `.reviewbox/reviews/${workspace.review.id}/review.json`),
      "utf8"
    )
  )
  assert.equal(shared.data.position, undefined)
  assert.equal(
    shared.data.repositoryId,
    JSON.parse(await readFile(join(repo, ".reviewbox/project.json"), "utf8"))
      .projectId
  )
  const mcp = Bun.spawn([binary, "mcp"], {
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  mcp.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "reviewbox_context",
        arguments: { repo, reviewId: workspace.review.id },
      },
    }) + "\n"
  )
  mcp.stdin.end()
  const response = JSON.parse(await new Response(mcp.stdout).text())
  assert.equal(await mcp.exited, 0)
  assert.equal(response.result.isError, false)
  assert.equal(response.result.structuredContent.reviewId, workspace.review.id)
  const status = await run(["git", "status", "--porcelain"])
  assert(status.includes(" M a.ts"))
  assert(status.includes("?? .reviewbox/"))
  console.log(
    "Headless CLI/MCP: create, annotate, enrich, tour and context passed; Git index unchanged."
  )
} finally {
  await rm(directory, { recursive: true, force: true })
}
