import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  copyFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import assert from "node:assert/strict"
import type {
  Repository,
  Workspace,
  Coverage,
  FileContent,
  ProjectSettings,
  ProjectKnowledge,
} from "../src/lib/desktop/contracts.generated"

const root = resolve(import.meta.dir, "..")
const temporary = await mkdtemp(join(tmpdir(), "reviewbox-native-"))
const repositoryPath = join(temporary, "repository")
await mkdir(repositoryPath)
const git = (...args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], { cwd: repositoryPath })
  if (result.exitCode) throw new Error(result.stderr.toString())
}
git("init", "-q")
git("config", "user.name", "ReviewBox fixture")
git("config", "user.email", "fixture@example.invalid")
await writeFile(
  join(repositoryPath, "example.ts"),
  "export const answer = 41;\n"
)
git("add", ".")
git("commit", "-qm", "Initial fixture")
await writeFile(
  join(repositoryPath, "example.ts"),
  "export const answer = 42;\n"
)
const port = 14445
const binary = join(temporary, "reviewbox-native")
await copyFile(resolve(root, "src-tauri/target/debug/reviewbox"), binary)
const child = Bun.spawn([binary], {
  cwd: root,
  env: {
    ...process.env,
    TAURI_WEBDRIVER_PORT: String(port),
    REVIEWBOX_VALIDATION_DATA: join(temporary, "data"),
  },
  stdout: "ignore",
  stderr: "pipe",
})
let session = ""
async function request<T>(
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST"
): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30000),
  })
  const json = (await response.json()) as { value: T; error?: string }
  if (!response.ok) throw new Error(JSON.stringify(json))
  return json.value
}
async function execute<T>(script: string, args: unknown[] = []): Promise<T> {
  try {
    return await request<T>(`/session/${session}/execute/sync`, {
      script,
      args,
    })
  } catch (cause) {
    throw new Error(`WebView command failed: ${script.slice(0, 80)}`, { cause })
  }
}
async function native<T>(command: string, args: object = {}): Promise<T> {
  console.log(`Native contract: ${command}`)
  const result = await request<{ value?: T; error?: unknown }>(
    `/session/${session}/execute/async`,
    {
      script:
        "const done=arguments[arguments.length-1];window.__TAURI_INTERNALS__.invoke(arguments[0],arguments[1]).then(value=>done({value})).catch(error=>done({error}));",
      args: [command, args],
    }
  )
  if (result.error) throw new Error(JSON.stringify(result.error))
  return result.value as T
}
async function waitFor(script: string) {
  for (let n = 0; n < 80; n++) {
    if (await execute<boolean>(script)) return
    await Bun.sleep(150)
  }
  throw new Error(`Timed out: ${script}`)
}
try {
  let ready = false
  for (let n = 0; n < 120; n++) {
    try {
      await request("/status")
      ready = true
      break
    } catch {
      await Bun.sleep(250)
    }
  }
  assert(ready, "Embedded native driver did not start")
  const started = await request<{ sessionId: string }>("/session", {
    capabilities: { alwaysMatch: { browserName: "tauri" } },
  })
  session = started.sessionId
  await waitFor(
    "return !!window.__TAURI_INTERNALS__ && !!document.querySelector('h1')"
  )
  const repo = await native<Repository>("open_repository", {
    path: repositoryPath,
  })
  let workspace = await native<Workspace>("create_review", {
    request: {
      repositoryId: repo.id,
      scope: "local",
      base: null,
      target: null,
      includeUntracked: false,
    },
  })
  assert.equal(workspace.snapshot.changes.length, 1)
  const projectSettings = await native<ProjectSettings>("project_settings", {
    repositoryId: repo.id,
  })
  const updatedSettings = await native<ProjectSettings>("configure_project", {
    repositoryId: repo.id,
    settings: { ...projectSettings, language: "English", provider: "claude" },
  })
  assert.equal(updatedSettings.language, "English")
  assert.equal(
    JSON.parse(
      await readFile(join(repositoryPath, ".reviewbox/settings.json"), "utf8")
    ).data.provider,
    "claude"
  )
  assert.equal(
    await native<boolean>("check_repository_changed", {
      snapshotId: workspace.snapshot.id,
    }),
    false
  )

  const change = workspace.snapshot.changes[0]
  const anchor = {
    snapshotId: workspace.snapshot.id,
    changeId: change.id,
    passageId: change.passages[0].id,
  }
  const frozen = await native<FileContent>("read_change", {
    snapshotId: workspace.snapshot.id,
    changeId: change.id,
  })
  assert.equal(frozen.after, "export const answer = 42;\n")
  workspace = await native<Workspace>("update_review", {
    id: workspace.review.id,
    revision: workspace.review.revision,
    action: {
      kind: "saveTopics",
      topics: [
        {
          id: "topic",
          title: "Correct the answer",
          brief: "Check exported behavior",
          steps: [
            {
              id: "step",
              title: "Return the expected value",
              documents: Object.fromEntries(
                ["beginner", "intermediate", "developer"].map((level) => [
                  level,
                  {
                    body: "The exported value changes from 41 to 42.",
                    readingSeconds: 10,
                    references: [],
                    terms: [],
                  },
                ])
              ),
              anchors: [anchor],
            },
          ],
        },
      ],
    },
  })
  workspace = await native<Workspace>("update_review", {
    id: workspace.review.id,
    revision: workspace.review.revision,
    action: { kind: "validateStep", stepId: "step" },
  })
  assert.equal(
    (await native<Coverage>("review_coverage", { id: workspace.review.id }))
      .complete,
    true,
    "authored steps alone finish the guided review"
  )
  assert(
    !workspace.review.decisions.some(
      (decision) => decision.target.kind === "file"
    ),
    "step validation does not validate the file"
  )
  workspace = await native<Workspace>("update_review", {
    id: workspace.review.id,
    revision: workspace.review.revision,
    action: {
      kind: "validateFile",
      fileId: workspace.review.files[0].id,
      level: "developer",
    },
  })
  assert.equal(
    (await native<Coverage>("review_coverage", { id: workspace.review.id }))
      .complete,
    true
  )

  await assert.rejects(() =>
    native("update_review", {
      id: workspace.review.id,
      revision: workspace.review.revision,
      action: { kind: "addAnnotation", anchor, body: "removed" },
    })
  )
  const knowledge = await native<ProjectKnowledge>("load_knowledge", {
    repositoryId: repo.id,
  })
  knowledge.terms.push({
    id: "term",
    term: "answer",
    aliases: [],
    senses: [{ id: "sense", description: "The exported response value" }],
    archived: false,
  })
  await native("save_knowledge", { knowledge })
  assert.equal(
    (
      await native<ProjectKnowledge>("load_knowledge", {
        repositoryId: repo.id,
      })
    ).terms.length,
    1
  )
  await assert.rejects(() =>
    native("prepare_test", {
      reviewId: workspace.review.id,
      command: ["/usr/bin/true"],
    })
  )
  await execute(
    'localStorage.setItem("reviewbox.reading-preferences",JSON.stringify({level:"developer",askEachReview:false}));window.location.reload();return true'
  )
  await waitFor(
    `return Array.from(document.querySelectorAll('button')).some(b=>b.textContent.includes(${JSON.stringify(repositoryPath)}))`
  )
  await execute(
    "Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes(arguments[0]))?.click();return true",
    [repositoryPath]
  )
  // A review with a written tour opens on its document; the code is one tab away.
  await waitFor("return !!document.querySelector('[aria-label=\"Review\"]')")
  await execute(
    "document.querySelector('[role=tab][aria-label=Code]')?.click();return true"
  )
  await waitFor(
    "return !!document.querySelector('[aria-label=\"Code diff\"]') && !!document.querySelector('.monaco-editor')"
  )
  await waitFor(
    "return [...document.querySelectorAll('.view-lines')].some(e=>e.textContent.includes('answer'))"
  )
  const cliEnvironment = {
    ...process.env,
    REVIEWBOX_VALIDATION_DATA: join(temporary, "data"),
  }
  const contextProcess = Bun.spawn(
    [binary, "context", "--repo", repositoryPath],
    { env: cliEnvironment, stdout: "pipe", stderr: "pipe" }
  )
  const context = JSON.parse(await new Response(contextProcess.stdout).text())
  assert.equal(await contextProcess.exited, 0)
  assert.equal(context.snapshotId, workspace.snapshot.id)
  const proposalPath = join(temporary, "proposal.json")
  await writeFile(
    proposalPath,
    JSON.stringify({
      snapshotId: workspace.snapshot.id,
      content: {
        kind: "explanation",
        path: "example.ts",
        sections: [
          {
            id: "section",
            title: "The answer",
            body: "Une constante exportée.",
            startLine: 1,
            endLine: 1,
          },
        ],
      },
    })
  )
  const proposalProcess = Bun.spawn(
    [binary, "propose", "--repo", repositoryPath, "--from", proposalPath],
    { env: cliEnvironment, stdout: "pipe", stderr: "pipe" }
  )
  const proposed = JSON.parse(await new Response(proposalProcess.stdout).text())
  assert.equal(await proposalProcess.exited, 0)
  assert.equal(proposed.status, "pending")
  await native("answer_proposal", {
    id: proposed.id,
    revision: proposed.revision,
    content: proposed.content,
    accepted: true,
  })
  workspace = await native<Workspace>("load_review", {
    id: workspace.review.id,
  })
  const explained = await native<ProjectKnowledge>("load_knowledge", {
    repositoryId: repo.id,
  })
  assert.equal(
    explained.documents.at(-1)?.sections[0].body,
    "Une constante exportée."
  )
  const mcp = Bun.spawn([binary, "mcp"], {
    env: cliEnvironment,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  mcp.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "validation", version: "1" },
      },
    }) + "\n"
  )
  mcp.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n"
  )
  mcp.stdin.end()
  const messages = (await new Response(mcp.stdout).text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
  assert.equal(await mcp.exited, 0)
  assert(
    !messages[1].result.tools.some((tool: { name: string }) =>
      /annotate|test|ask/.test(tool.name)
    )
  )
  const tour = await native<
    import("../src/lib/desktop/contracts.generated").OnboardingTour
  >("save_onboarding_tour", {
    tour: {
      id: crypto.randomUUID(),
      repositoryId: repo.id,
      title: "Learn",
      revision: 0,
      steps: [
        {
          id: "s1",
          title: "Read answer",
          explanation: "A constant",
          path: "example.ts",
          startLine: 1,
          endLine: 1,
          quote: "",
          fingerprint: "",
          visited: false,
        },
      ],
    },
  })
  const currentStep = await native<
    import("../src/lib/desktop/contracts.generated").CurrentTourStep
  >("read_onboarding_step", { tourId: tour.id, stepId: "s1" })
  assert.equal(currentStep.status, "current")
  const servers = await native<
    import("../src/lib/desktop/contracts.generated").LanguageServerSettings
  >("language_server_settings")
  await native("configure_language_servers", {
    settings: {
      ...servers,
      servers: [
        {
          id: "fixture",
          name: "Protocol fixture",
          extensions: ["ts"],
          executable: process.execPath,
          arguments: [resolve(root, "tests/fixtures/language-server.mjs")],
        },
      ],
    },
  })
  const locations = await native<
    import("../src/lib/desktop/contracts.generated").CodeLocation[]
  >("find_definition", {
    snapshotId: workspace.snapshot.id,
    path: "example.ts",
    line: 1,
    column: 14,
  })
  assert.equal(locations[0]?.path, "example.ts")
  assert.equal(locations[0]?.column, 14)
  const image = await request<string>(`/session/${session}/screenshot`)
  await mkdir(resolve(root, "artifacts/validation"), { recursive: true })
  await Bun.write(
    resolve(root, "artifacts/validation/native-review.png"),
    Buffer.from(image, "base64")
  )
  await writeFile(
    join(repositoryPath, "example.ts"),
    "export const answer = 43;\n"
  )
  assert.equal(
    await native<boolean>("check_repository_changed", {
      snapshotId: workspace.snapshot.id,
    }),
    true
  )
  assert.equal(
    (
      await native<FileContent>("read_change", {
        snapshotId: workspace.snapshot.id,
        changeId: change.id,
      })
    ).after,
    frozen.after
  )
  workspace = await native<Workspace>("load_review", {
    id: workspace.review.id,
  })
  workspace = await native<Workspace>("refresh_review", {
    id: workspace.review.id,
    revision: workspace.review.revision,
  })
  assert.equal(
    (await native<Coverage>("review_coverage", { id: workspace.review.id }))
      .validated,
    0
  )
  assert.equal(workspace.review.previousSnapshotIds.length, 1)
  const receipt = {
    platform: process.platform,
    runtime: "native WebView + real Rust IPC",
    passed: [
      "project settings and portable storage",
      "Git capture",
      "frozen diff",
      "topics",
      "human validation",
      "removed annotation and test APIs rejected",
      "glossary persistence",
      "review after reload",
      "Monaco mount",
      "external changes",
      "targeted invalidation",
      "CLI context and pending proposal",
      "proposal acceptance",
      "MCP initialize and tools",
      "current-code onboarding",
      "LSP protocol fixture",
    ],
    providersStarted: false,
  }
  await Bun.write(
    resolve(root, "artifacts/validation/native-receipt.json"),
    JSON.stringify(receipt, null, 2)
  )
  console.log(JSON.stringify(receipt, null, 2))
} catch (error) {
  if (session) {
    console.error(
      await execute("return document.body.innerText").catch(() => "No page")
    )
    const image = await request<string>(`/session/${session}/screenshot`).catch(
      () => null
    )
    if (image)
      await Bun.write(
        resolve(root, "artifacts/validation/native-error.png"),
        Buffer.from(image, "base64")
      )
  }
  throw error
} finally {
  if (session)
    await request(`/session/${session}`, undefined, "DELETE").catch(() => {})
  child.kill()
  await child.exited
  await rm(temporary, { recursive: true, force: true })
}
