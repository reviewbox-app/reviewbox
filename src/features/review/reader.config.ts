import { codeFileHeaderHeight } from "@/features/code-editor/components/CodeFileHeader"

/** Shared shell dimensions for captured reviews and live local changes (pixels). */
export const reviewReaderLayout = {
  headerHeight: 48,
  footerHeight: 42,
  codeHeaderHeight: codeFileHeaderHeight,
  codeStatusHeight: 28,
  contentInset: 8,
} as const
