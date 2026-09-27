import { describe, expect, test } from "bun:test"
import type { ProviderModel } from "@/lib/desktop/contracts.generated"
import { selectedModel } from "./model.helpers"

const models: ProviderModel[] = [
  {
    id: "sonnet[1m]",
    name: "Sonnet 1M",
    resolvedModel: "claude-sonnet-5",
    description: "",
    supportedEfforts: [],
  },
  {
    id: "sonnet",
    name: "Sonnet",
    resolvedModel: "claude-sonnet-5",
    description: "",
    supportedEfforts: ["medium"],
  },
  {
    id: "gpt-6-sol",
    name: "GPT-6 Sol",
    resolvedModel: null,
    description: "",
    supportedEfforts: ["medium"],
  },
]

describe("harness model selection", () => {
  test("matches pinned defaults to their alias without selecting a context variant", () => {
    expect(selectedModel(models, "claude-sonnet-5")?.id).toBe("sonnet")
    expect(selectedModel(models, "sonnet[1m]")?.id).toBe("sonnet[1m]")
    expect(selectedModel(models, "gpt-6-sol")?.id).toBe("gpt-6-sol")
  })
  test("keeps inherited and unlisted models distinct", () => {
    expect(selectedModel(models, null)).toBeUndefined()
    expect(selectedModel(models, "custom-model")).toBeUndefined()
  })
})
