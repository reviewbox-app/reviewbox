import { defineConfig, globalIgnores } from "eslint/config"
import nextVitals from "eslint-config-next/core-web-vitals"
import nextTs from "eslint-config-next/typescript"
import prettier from "eslint-config-prettier/flat"

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  prettier,
  globalIgnores([
    ".next/**",
    "out/**",
    "src-tauri/target/**",
    "src-tauri/gen/**",
    "public/monaco/**",
    "artifacts/**",
    "next-env.d.ts",
  ]),
])
