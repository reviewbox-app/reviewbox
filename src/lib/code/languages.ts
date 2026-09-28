export interface CodeLanguage {
  /** TextMate / Monaco identity, distinct from the language-server identity. */
  id: string
  name: string
  lspId: string
  extensions: readonly string[]
  filenames?: readonly string[]
  aliases?: readonly string[]
}

/** One registry for captured sources, Markdown snippets and native adapters. */
export const codeLanguages: readonly CodeLanguage[] = [
  {
    id: "typescript",
    name: "TypeScript",
    lspId: "typescript",
    extensions: ["ts", "mts", "cts"],
  },
  {
    id: "tsx",
    name: "TSX",
    lspId: "typescriptreact",
    extensions: ["tsx"],
    aliases: ["typescriptreact"],
  },
  {
    id: "javascript",
    name: "JavaScript",
    lspId: "javascript",
    extensions: ["js", "mjs", "cjs"],
  },
  {
    id: "jsx",
    name: "JSX",
    lspId: "javascriptreact",
    extensions: ["jsx"],
    aliases: ["javascriptreact"],
  },
  { id: "vue", name: "Vue", lspId: "vue", extensions: ["vue"] },
  { id: "svelte", name: "Svelte", lspId: "svelte", extensions: ["svelte"] },
  { id: "astro", name: "Astro", lspId: "astro", extensions: ["astro"] },
  { id: "rust", name: "Rust", lspId: "rust", extensions: ["rs"] },
  {
    id: "python",
    name: "Python",
    lspId: "python",
    extensions: ["py", "pyi", "pyw"],
  },
  { id: "go", name: "Go", lspId: "go", extensions: ["go"] },
  { id: "c", name: "C", lspId: "c", extensions: ["c"] },
  {
    id: "cpp",
    name: "C++",
    lspId: "cpp",
    extensions: ["cpp", "cc", "cxx", "h", "hpp", "hxx"],
  },
  {
    id: "csharp",
    name: "C#",
    lspId: "csharp",
    extensions: ["cs"],
    aliases: ["c#"],
  },
  { id: "java", name: "Java", lspId: "java", extensions: ["java"] },
  { id: "kotlin", name: "Kotlin", lspId: "kotlin", extensions: ["kt", "kts"] },
  { id: "swift", name: "Swift", lspId: "swift", extensions: ["swift"] },
  { id: "dart", name: "Dart", lspId: "dart", extensions: ["dart"] },
  {
    id: "ruby",
    name: "Ruby",
    lspId: "ruby",
    extensions: ["rb", "rake", "gemspec"],
    filenames: ["Gemfile", "Rakefile"],
  },
  { id: "php", name: "PHP", lspId: "php", extensions: ["php", "phtml"] },
  { id: "lua", name: "Lua", lspId: "lua", extensions: ["lua"] },
  {
    id: "shellscript",
    name: "Shell",
    lspId: "shellscript",
    extensions: ["sh", "bash", "zsh", "fish"],
    filenames: [".bashrc", ".zshrc", ".profile"],
    aliases: ["shell", "bash", "sh", "zsh"],
  },
  {
    id: "powershell",
    name: "PowerShell",
    lspId: "powershell",
    extensions: ["ps1", "psm1", "psd1"],
  },
  { id: "html", name: "HTML", lspId: "html", extensions: ["html", "htm"] },
  { id: "css", name: "CSS", lspId: "css", extensions: ["css"] },
  { id: "scss", name: "SCSS", lspId: "scss", extensions: ["scss"] },
  { id: "sass", name: "Sass", lspId: "sass", extensions: ["sass"] },
  { id: "less", name: "Less", lspId: "less", extensions: ["less"] },
  {
    id: "json",
    name: "JSON",
    lspId: "json",
    extensions: ["json"],
    filenames: [".babelrc", ".prettierrc"],
  },
  {
    id: "jsonc",
    name: "JSON with comments",
    lspId: "jsonc",
    extensions: ["jsonc"],
    filenames: ["tsconfig.json", "jsconfig.json"],
  },
  { id: "yaml", name: "YAML", lspId: "yaml", extensions: ["yaml", "yml"] },
  {
    id: "toml",
    name: "TOML",
    lspId: "toml",
    extensions: ["toml"],
    filenames: ["Cargo.lock"],
  },
  { id: "ini", name: "INI", lspId: "ini", extensions: ["ini", "cfg"] },
  {
    id: "dotenv",
    name: "Environment",
    lspId: "dotenv",
    extensions: ["env"],
    filenames: [".env"],
  },
  {
    id: "xml",
    name: "XML",
    lspId: "xml",
    extensions: ["xml", "svg", "xsl", "plist", "csproj"],
  },
  {
    id: "markdown",
    name: "Markdown",
    lspId: "markdown",
    extensions: ["md", "markdown", "mdown"],
  },
  { id: "mdx", name: "MDX", lspId: "mdx", extensions: ["mdx"] },
  { id: "sql", name: "SQL", lspId: "sql", extensions: ["sql"] },
  {
    id: "graphql",
    name: "GraphQL",
    lspId: "graphql",
    extensions: ["graphql", "gql"],
  },
  { id: "prisma", name: "Prisma", lspId: "prisma", extensions: ["prisma"] },
  {
    id: "dockerfile",
    name: "Dockerfile",
    lspId: "dockerfile",
    extensions: ["dockerfile"],
    filenames: ["Dockerfile", "Containerfile"],
  },
  {
    id: "makefile",
    name: "Makefile",
    lspId: "makefile",
    extensions: ["mk"],
    filenames: ["Makefile", "GNUmakefile"],
  },
  {
    id: "cmake",
    name: "CMake",
    lspId: "cmake",
    extensions: ["cmake"],
    filenames: ["CMakeLists.txt"],
  },
  {
    id: "hcl",
    name: "HCL",
    lspId: "terraform",
    extensions: ["hcl", "tf", "tfvars"],
  },
  {
    id: "protobuf",
    name: "Protocol Buffers",
    lspId: "proto",
    extensions: ["proto"],
  },
  { id: "r", name: "R", lspId: "r", extensions: ["r"] },
  { id: "scala", name: "Scala", lspId: "scala", extensions: ["scala", "sc"] },
  { id: "elixir", name: "Elixir", lspId: "elixir", extensions: ["ex", "exs"] },
  { id: "erlang", name: "Erlang", lspId: "erlang", extensions: ["erl", "hrl"] },
  {
    id: "clojure",
    name: "Clojure",
    lspId: "clojure",
    extensions: ["clj", "cljs", "cljc", "edn"],
  },
  {
    id: "haskell",
    name: "Haskell",
    lspId: "haskell",
    extensions: ["hs", "lhs"],
  },
  { id: "ocaml", name: "OCaml", lspId: "ocaml", extensions: ["ml", "mli"] },
  { id: "zig", name: "Zig", lspId: "zig", extensions: ["zig"] },
  { id: "diff", name: "Diff", lspId: "diff", extensions: ["diff", "patch"] },
]

const plaintext: CodeLanguage = {
  id: "plaintext",
  name: "Plain text",
  lspId: "plaintext",
  extensions: [],
}
const pseudo: CodeLanguage = {
  id: "reviewbox-pseudocode",
  name: "Pseudo-code",
  lspId: "reviewbox-pseudocode",
  extensions: [],
  aliases: ["pseudo", "pseudocode", "pseudo-code"],
}

export function resolveLanguageId(id: string | undefined): CodeLanguage {
  const value = id?.toLowerCase()
  return (
    [pseudo, ...codeLanguages].find(
      (language) =>
        language.id === value ||
        language.aliases?.includes(value ?? "") ||
        language.extensions.includes(value ?? "")
    ) ?? plaintext
  )
}

export function resolveCodeLanguage(
  path: string,
  firstLine?: string
): CodeLanguage {
  const name = path.replaceAll("\\", "/").split("/").at(-1) ?? ""
  const named = codeLanguages.find((language) =>
    language.filenames?.some(
      (file) => file.toLowerCase() === name.toLowerCase()
    )
  )
  if (named) return named
  if (/^\.env\./i.test(name)) return resolveLanguageId("dotenv")
  if (/^(?:Dockerfile|Containerfile)\./i.test(name))
    return resolveLanguageId("dockerfile")
  if (/^(?:tsconfig|jsconfig)(?:\.[^.]+)+\.json$/i.test(name))
    return resolveLanguageId("jsonc")
  const extension = name.includes(".")
    ? name.split(".").at(-1)?.toLowerCase()
    : ""
  const known = codeLanguages.find((language) =>
    language.extensions.includes(extension ?? "")
  )
  if (known) return known
  if (firstLine?.startsWith("#!")) {
    const interpreter =
      /\b(python(?:\d+(?:\.\d+)?)?|node|deno|bun|ruby|perl|(?:ba|z|k)?sh|fish)\b/.exec(
        firstLine
      )?.[1]
    if (interpreter?.startsWith("python")) return resolveLanguageId("python")
    if (interpreter && ["node", "deno", "bun"].includes(interpreter))
      return resolveLanguageId("javascript")
    if (interpreter === "ruby") return resolveLanguageId("ruby")
    if (interpreter && /sh$|fish/.test(interpreter))
      return resolveLanguageId("shellscript")
  }
  return plaintext
}
