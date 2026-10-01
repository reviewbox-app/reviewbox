import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { beginProgress } from "../helpers/preparationProgress.helpers"
import { PreparationWorkers } from "./PreparationWorkers"
import { PreparationSteps } from "./PreparationSteps"

test("all active helpers and coordinators remain outside bounded activity history", () => {
  const progress = beginProgress("run")
  for (let i = 0; i < 24; i++) {
    progress.helpers[`helper-${i}`] = {
      type: "delegation",
      id: `helper-${i}`,
      parent: "root",
      task: `Task ${i}`,
      model: "Luna",
      status: "inProgress",
    }
  }
  const html = renderToStaticMarkup(
    <PreparationWorkers
      progress={progress}
      batches={Array.from({ length: 8 }, (_, i) => ({
        id: String(i),
        label: `Batch ${i}`,
        phase: "documents",
        model: "Sol",
        startedAt: "0",
        status: "running",
      }))}
    />
  )
  for (let i = 0; i < 24; i++) expect(html).toContain(`Task ${i}`)
  expect(html).toContain("8 coordinators assigned")
  expect(html).not.toContain("overflow-y")
  expect(html).not.toContain("max-h-")
  const steps = renderToStaticMarkup(
    <PreparationSteps
      steps={Array.from({ length: 50 }, (_, i) => ({
        id: String(i),
        title: `Step ${i}`,
        status: "queued",
      }))}
      status="running"
    />
  )
  expect(steps).not.toContain("overflow-y")
  expect(steps).not.toContain("max-h-")
})
