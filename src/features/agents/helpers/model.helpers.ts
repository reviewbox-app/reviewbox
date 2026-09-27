import type { ProviderModel } from "@/lib/desktop/contracts.generated"

/** A bare resolved identifier must not accidentally select a context variant. */
export function selectedModel(models: ProviderModel[], value: string | null) {
  if (!value) return undefined
  return (
    models.find((model) => model.id === value) ??
    models.find(
      (model) => model.resolvedModel === value && !model.id.includes("[")
    )
  )
}
