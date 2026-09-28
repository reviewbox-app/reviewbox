import { call } from "@/lib/desktop/review.commands"
import type {
  FrozenSource,
  ReadingLevel,
  ReviewFileContent,
} from "@/lib/desktop/contracts.generated"

export const readerCommands = {
  source: (snapshotId: string, sourceId: string) =>
    call<FrozenSource>("read_review_source", { snapshotId, sourceId }),
  file: (reviewId: string, fileId: string) =>
    call<ReviewFileContent>("read_review_file", { reviewId, fileId }),
  exportSummary: (id: string, level: ReadingLevel) =>
    call<boolean>("export_review_summary", { id, level }),
}
