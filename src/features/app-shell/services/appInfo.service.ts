import { invoke, isTauri } from "@tauri-apps/api/core"
import type { AppInfo } from "../contracts/appInfo.types"

export async function getAppInfo(): Promise<AppInfo> {
  if (!isTauri()) {
    throw new Error(
      "Les informations natives sont disponibles dans l’application desktop."
    )
  }

  return invoke<AppInfo>("get_app_info")
}
