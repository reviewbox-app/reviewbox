"use client"
import { RuntimeErrorPanel } from "@/features/diagnostics/components/RuntimeErrorPanel"
import "./globals.css"

export default function GlobalError(props: {
  error: Error & { digest?: string }
  retry: () => void
}) {
  return (
    <html lang="en">
      <body>
        <RuntimeErrorPanel {...props} />
      </body>
    </html>
  )
}
