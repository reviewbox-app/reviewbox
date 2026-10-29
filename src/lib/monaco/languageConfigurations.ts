import type * as M from "monaco-editor/editor/editor.api"
import { codeLanguages } from "@/lib/code/languages"

/** Import configuration data, leaving TextMate in charge of tokenization. */
export async function registerLanguageConfigurations(monaco: typeof M) {
  const [ts, html, css, xml] = await Promise.all([
    import("monaco-editor/languages/definitions/typescript/typescript"),
    import("monaco-editor/languages/definitions/html/html"),
    import("monaco-editor/languages/definitions/css/css"),
    import("monaco-editor/languages/definitions/xml/xml"),
  ])
  const generic: M.languages.LanguageConfiguration = {
    brackets: [
      ["{", "}"],
      ["[", "]"],
      ["(", ")"],
    ],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
    ],
  }
  for (const language of codeLanguages) {
    const id = language.id
    const config = [
      "typescript",
      "javascript",
      "tsx",
      "jsx",
      "hlsl",
      "glsl",
      "cg",
      "prisma",
      "slang",
    ].includes(id)
      ? ts.conf
      : ["html", "vue", "svelte", "astro"].includes(id)
        ? html.conf
        : ["css", "scss", "less"].includes(id)
          ? css.conf
          : ["xml", "svg"].includes(id)
            ? xml.conf
            : generic
    monaco.languages.setLanguageConfiguration(id, {
      ...config,
      brackets: config.brackets ?? generic.brackets,
      colorizedBracketPairs: generic.brackets,
    })
  }
}
