"use client"
import { RuntimeErrorPanel } from "@/features/diagnostics/components/RuntimeErrorPanel"

export default function ErrorPage(props: {
  error: Error & { digest?: string }
  retry: () => void
}) {
  return <RuntimeErrorPanel {...props} />
}
