import type { NextConfig } from "next"

const enableDevtools =
  process.env.NODE_ENV === "development" ||
  process.env.REVIEWBOX_DEVTOOLS === "1"

const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  // A normal build never discovers the development page or its client imports.
  pageExtensions: enableDevtools ? ["dev.tsx", "tsx", "ts"] : ["tsx", "ts"],
  devIndicators: false,
}

export default nextConfig
