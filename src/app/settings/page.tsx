"use client"
import { SettingsDialog } from "@/features/settings/composites/SettingsDialog"
export default function SettingsPage() {
  return (
    <SettingsDialog
      open
      standalone
      onClose={() => {
        void import("@tauri-apps/api/window").then(({ getCurrentWindow }) =>
          getCurrentWindow().close()
        )
      }}
    />
  )
}
