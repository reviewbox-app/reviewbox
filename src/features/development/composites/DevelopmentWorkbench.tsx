"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import type { Editor as TiptapEditor, JSONContent } from "@tiptap/react"
import type * as Monaco from "monaco-editor"
import type { editor } from "monaco-editor"
import { isTauri } from "@tauri-apps/api/core"
import { z } from "zod"
import { Button } from "@/components/ui/button"
import { CodeEditor } from "@/features/code-editor/components/CodeEditor"
import { CodeDiffEditor } from "@/features/code-editor/components/CodeDiffEditor"
import { RichTextEditor } from "@/features/rich-text-editor/components/RichTextEditor"
import { getAppInfo } from "@/features/app-shell/services/appInfo.service"
import { AnimationProbe } from "../components/AnimationProbe"
import {
  probeDiff,
  probeLanguageWorkers,
  waitForProbe,
} from "../helpers/editorProbes.helpers"
import { useWorkbenchStore } from "../stores/useWorkbench.store"

const nativeInfoSchema = z.object({
  name: z.literal("ReviewBox"),
  version: z.string().min(1),
})

export function DevelopmentWorkbench() {
  const [mounted, setMounted] = useState(true)
  const [running, setRunning] = useState(false)
  const [results, setResults] = useState<string[]>([])
  const [failure, setFailure] = useState<string>()
  const [document, setDocument] = useState<JSONContent>()
  const count = useWorkbenchStore((state) => state.count)
  const increment = useWorkbenchStore((state) => state.increment)
  const code = useRef<{
    editor: editor.IStandaloneCodeEditor
    monaco: typeof Monaco
  } | null>(null)
  const diff = useRef<editor.IStandaloneDiffEditor | null>(null)
  const richText = useRef<TiptapEditor | null>(null)
  const alive = useRef(true)
  const activeRun = useRef<AbortController | null>(null)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      activeRun.current?.abort()
      activeRun.current = null
      code.current = null
      diff.current = null
      richText.current = null
    }
  }, [])

  const onCodeMount = useCallback(
    (instance: editor.IStandaloneCodeEditor, monaco: typeof Monaco) => {
      code.current = { editor: instance, monaco }
    },
    []
  )
  const onDiffMount = useCallback((instance: editor.IStandaloneDiffEditor) => {
    diff.current = instance
  }, [])
  const onRichTextReady = useCallback((instance: TiptapEditor) => {
    richText.current = instance
  }, [])

  async function runProbes() {
    if (activeRun.current) return
    if (!code.current || !diff.current || !richText.current) {
      setFailure(
        "Attendre le chargement des éditeurs avant de lancer les vérifications."
      )
      return
    }
    const { editor: instance, monaco } = code.current
    const diffInstance = diff.current
    const tiptap = richText.current
    const controller = new AbortController()
    const { signal } = controller
    activeRun.current = controller
    setRunning(true)
    setFailure(undefined)
    setResults([])
    const isCurrent = () =>
      alive.current && activeRun.current === controller && !signal.aborted
    const addResult = (result: string) => {
      if (isCurrent()) setResults((previous) => [...previous, result])
    }

    try {
      if (isTauri()) {
        const info = nativeInfoSchema.parse(
          await waitForProbe(getAppInfo(), "IPC natif", signal)
        )
        addResult(`IPC natif : ${info.name} ${info.version}`)
      } else {
        addResult("IPC natif : non testé dans le navigateur")
      }
      signal.throwIfAborted()
      const before = useWorkbenchStore.getState().count
      useWorkbenchStore.getState().increment()
      if (useWorkbenchStore.getState().count !== before + 1)
        throw new Error("État Zustand incohérent")
      addResult("Zustand : incrément vérifié")
      const languages = await probeLanguageWorkers(monaco, instance, signal)
      languages.forEach(addResult)
      addResult(await probeDiff(diffInstance, signal))
      signal.throwIfAborted()
      tiptap.commands.setContent("<p>ReviewBox</p>")
      tiptap.chain().selectAll().toggleBold().run()
      if (!tiptap.isActive("bold"))
        throw new Error("La commande Tiptap bold a échoué")
      addResult("Tiptap : document édité et mise en forme appliquée")
      addResult("Vérifications terminées")
    } catch (error) {
      if (isCurrent())
        setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      if (activeRun.current === controller) {
        activeRun.current = null
        if (alive.current) setRunning(false)
      }
    }
  }

  function toggleEditors() {
    if (mounted) {
      code.current = null
      diff.current = null
      richText.current = null
    }
    setMounted(!mounted)
  }

  return (
    <main className="mx-auto max-w-6xl space-y-6 p-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">
            ReviewBox — banc de développement
          </h1>
          <p className="text-sm text-muted-foreground">
            Fixtures locales, sans dépôt ni agent connecté.
          </p>
        </div>
        <Link href="/" className="text-sm underline">
          Accueil
        </Link>
      </header>
      <section className="space-y-3 rounded-xl border p-4">
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={runProbes} disabled={!mounted || running}>
            Tester le socle
          </Button>
          <Button variant="outline" onClick={toggleEditors} disabled={running}>
            {mounted ? "Démonter les éditeurs" : "Remonter les éditeurs"}
          </Button>
          <Button variant="secondary" onClick={increment}>
            Compteur : {count}
          </Button>
        </div>
        {mounted && <AnimationProbe count={count} />}
        <div aria-live="polite" className="space-y-1 text-sm">
          {running && <p>Vérification en cours…</p>}
          {results.map((result) => (
            <p key={result}>{result}</p>
          ))}
          {failure && (
            <p role="alert" className="text-destructive">
              {failure}
            </p>
          )}
        </div>
      </section>
      {mounted && (
        <>
          <section className="space-y-2">
            <h2 className="font-medium">Monaco — TypeScript</h2>
            <CodeEditor
              defaultLanguage="typescript"
              defaultValue={'const review = "ReviewBox";'}
              height={220}
              onMount={onCodeMount}
            />
          </section>
          <section className="space-y-2">
            <h2 className="font-medium">Monaco — diff</h2>
            <CodeDiffEditor
              language="typescript"
              original="const ready = false;"
              modified="const ready = true;"
              height={220}
              onMount={onDiffMount}
            />
          </section>
          <section className="space-y-2">
            <h2 className="font-medium">Tiptap — note locale</h2>
            <RichTextEditor
              initialContent="<p>Une note de review.</p>"
              onReady={onRichTextReady}
              onChange={setDocument}
              ariaLabel="Note de validation"
            />
            <pre className="overflow-auto rounded-lg bg-muted p-3 text-xs">
              {JSON.stringify(document ?? {}, null, 2)}
            </pre>
          </section>
        </>
      )}
    </main>
  )
}
