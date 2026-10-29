import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"

/** Real, disposable projects; this never installs dependencies in the user checkout. */
export function extensionProjects(root: string) {
  fs.mkdirSync(root, { recursive: true })
  for (const [name, deps] of Object.entries({
    web: {
      typescript: "5.9.3",
      react: "18.3.1",
      "@types/react": "18.3.27",
      vue: "3.5.24",
      prettier: "3.9.6",
    },
    tailwind3: { tailwindcss: "3.4.17" },
    tailwind4: { tailwindcss: "4.1.18" },
  })) {
    const dir = path.join(root, name)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({
        name: "reviewbox-fixture-" + name,
        private: true,
        dependencies: deps,
      })
    )
    execFileSync(
      "npm",
      ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
      { cwd: dir, stdio: "pipe" }
    )
    console.log("Fixture", name)
  }
  fs.writeFileSync(
    path.join(root, "web/tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        jsx: "react-jsx",
        strict: true,
        module: "ESNext",
        moduleResolution: "Bundler",
        target: "ES2020",
        baseUrl: ".",
        paths: { "@/*": ["src/*"] },
      },
      include: ["**/*.ts", "**/*.tsx", "**/*.vue"],
    })
  )
  fs.mkdirSync(path.join(root, "web/src"), { recursive: true })
  fs.writeFileSync(
    path.join(root, "web/src/Button.tsx"),
    "export const ReviewButton = (props: {label:string}) => <button>{props.label}</button>\n"
  )
  fs.writeFileSync(
    path.join(root, "web/Child.vue"),
    '<script setup lang="ts">defineProps<{label: string}>()</script><template><button>{{ label }}</button></template>'
  )
  fs.writeFileSync(
    path.join(root, "web/.prettierrc.json"),
    JSON.stringify({ semi: false, singleQuote: true, tabWidth: 4 })
  )
  fs.writeFileSync(
    path.join(root, "web/.editorconfig"),
    "root = true\n[*]\nindent_style = space\nindent_size = 4\n"
  )
  fs.writeFileSync(path.join(root, "web/.prettierignore"), "ignored.ts\n")
  fs.writeFileSync(
    path.join(root, "tailwind3/tailwind.config.cjs"),
    "module.exports = {content: ['./**/*.{tsx,html,vue}'], theme: {extend: {colors: {brand: '#abcdef'}}}}\n"
  )
  fs.writeFileSync(
    path.join(root, "tailwind3/style.css"),
    "@tailwind utilities;\n"
  )
  fs.writeFileSync(
    path.join(root, "tailwind4/style.css"),
    '@import "tailwindcss";\n@theme { --color-brand: #abcdef; }\n'
  )
  for (const name of ["tailwind3", "tailwind4"])
    fs.writeFileSync(
      path.join(root, name, "main.tsx"),
      'export const Card = () => <div className="bg-brand flex"></div>\n'
    )
}
