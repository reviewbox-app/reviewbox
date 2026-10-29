import type * as Monaco from "monaco-editor/editor/editor.api"
import { decorateColors } from "./colors"
import { loadExtensions } from "./extensions.store"

/** Reading surfaces share visual extensions, without registering text mutations. */
export function bindReadOnlyFeatures(
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel
) {
  void loadExtensions().catch(() => {})
  return decorateColors(monaco, model, async () => [])
}
