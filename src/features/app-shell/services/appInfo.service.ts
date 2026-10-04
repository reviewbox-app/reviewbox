import { call, desktopAvailable } from "@/lib/desktop/review.commands"
import type { AppInfo } from "../contracts/appInfo.types"

export async function getAppInfo(): Promise<AppInfo> {
  if (!desktopAvailable()) {
    throw new Error(
      "Les informations natives sont disponibles dans l’application desktop."
    )
  }

  return call<AppInfo>("get_app_info")
}
