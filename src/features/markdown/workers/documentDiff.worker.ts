import type {
  DocumentDiffRequest,
  DocumentDiffResponse,
} from "../contracts/documentDiff.types"
import { compareDocuments } from "../helpers/documentDiff.helpers"

self.onmessage = (event: MessageEvent<DocumentDiffRequest>) => {
  let response: DocumentDiffResponse
  try {
    response = { result: compareDocuments(event.data) }
  } catch (error) {
    response = {
      error:
        error instanceof Error
          ? error.message
          : "Markdown could not be rendered.",
    }
  }
  self.postMessage(response)
}
