"use client"

import { useMemo, useState } from "react"
import { useTheme } from "next-themes"
import { GroupedFileTree } from "@/features/file-tree/components/GroupedFileTree"
import { FileTree } from "@/features/file-tree/components/FileTree"
import { groupFiles } from "@/features/file-tree/helpers/groupFiles.helpers"
import { Button } from "@/components/ui/button"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Input } from "@/components/ui/input"
import type { GitFileStatus } from "@/lib/git/file-status"

const examples: Record<string, string[]> = {
  "Feature project": [
    ...[
      "components/ReviewHeader.tsx",
      "components/ReviewFooter.tsx",
      "components/ReviewCard.tsx",
      "hooks/useReviewSession.ts",
      "services/review.commands.ts",
      "contracts/review.types.ts",
    ].map((p) => `src/features/review/${p}`),
    ...[
      "components/SettingsDialog.tsx",
      "components/ThemePicker.tsx",
      "hooks/useSettings.ts",
      "services/preferences.ts",
    ].map((p) => `src/features/settings/${p}`),
    ...[
      "components/CommitDialog.tsx",
      "components/LocalChanges.tsx",
      "hooks/useGitStatus.ts",
      "services/git.commands.ts",
      "helpers/selection.ts",
    ].map((p) => `src/features/source-control/${p}`),
    "src/lib/utils.ts",
    "src/app/layout.tsx",
    "README.md",
    "package.json",
  ],
  Monorepo: [
    ...[
      "src/client.ts",
      "src/types.ts",
      "tests/client.test.ts",
      "package.json",
    ].map((p) => `packages/api/${p}`),
    ...[
      "src/Button.tsx",
      "src/Dialog.tsx",
      "src/theme.css",
      "tests/Button.test.tsx",
    ].map((p) => `packages/ui/${p}`),
    ...[
      "app/page.tsx",
      "app/layout.tsx",
      "components/Header.tsx",
      "components/Footer.tsx",
      "next.config.ts",
    ].map((p) => `apps/web/${p}`),
    "pnpm-workspace.yaml",
    "README.md",
  ],
  "Mixed layout": [
    "app/controllers/orders.rb",
    "app/controllers/payments.rb",
    "app/models/order.rb",
    "app/models/payment.rb",
    "app/views/orders/show.html.erb",
    "db/migrate/20261012_add_payment_state.rb",
    "db/schema.rb",
    "config/routes.rb",
    "spec/requests/orders_spec.rb",
    "spec/requests/payments_spec.rb",
    "spec/models/order_spec.rb",
    "spec/models/payment_spec.rb",
    "Gemfile",
    "README.md",
  ],
  "Large change": Array.from({ length: 8 }, (_, i) =>
    [
      "index.ts",
      "components/Panel.tsx",
      "hooks/useData.ts",
      "tests/data.test.ts",
    ].map((p) => `src/modules/module-${i + 1}/${p}`)
  ).flat(),
}

export function GroupedFilesWorkbench() {
  const [example, setExample] = useState("Feature project")
  const [mode, setMode] = useState("grouped")
  const [query, setQuery] = useState("")
  const [selected, setSelected] = useState(examples[example][0])
  const [staged, setStaged] = useState<Set<string>>(new Set())
  const { resolvedTheme, setTheme } = useTheme()
  const paths = examples[example]
  const statuses = useMemo(
    () =>
      Object.fromEntries(
        paths.map((p, i) => [
          p,
          (["M", "M", "A", "D", "R", "U"] as GitFileStatus[])[i % 6],
        ])
      ),
    [paths]
  )
  const visible = paths.filter((p) =>
    p.toLowerCase().includes(query.toLowerCase())
  )
  const groups = useMemo(() => groupFiles(paths), [paths])
  return (
    <main className="flex h-screen flex-col bg-background pt-8 text-foreground">
      <header className="flex flex-wrap items-center gap-3 border-b px-6 py-4">
        <div className="mr-auto">
          <h1 className="text-lg font-semibold">
            Local changes · grouped files
          </h1>
          <p className="text-xs text-muted-foreground">
            Interactive demo · sample files only
          </p>
        </div>
        <label className="text-xs text-muted-foreground">
          Project layout{" "}
          <select
            aria-label="Project layout"
            className="ml-2 rounded-lg bg-muted p-2 text-foreground"
            value={example}
            onChange={(e) => {
              setExample(e.target.value)
              setSelected(examples[e.target.value][0])
              setQuery("")
              setStaged(new Set())
            }}
          >
            {Object.keys(examples).map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        </label>
        <Button
          variant="ghost"
          onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
        >
          Switch theme
        </Button>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside
          className="flex w-[390px] shrink-0 resize-x flex-col overflow-hidden border-r"
          style={{ minWidth: 300, maxWidth: 640 }}
        >
          <div className="space-y-3 p-4">
            <Tabs value={mode} onValueChange={setMode}>
              <TabsList className="w-full" aria-label="File layout">
                <TabsTrigger value="grouped">Grouped</TabsTrigger>
                <TabsTrigger value="tree">Tree</TabsTrigger>
              </TabsList>
            </Tabs>
            <Input
              aria-label="Filter files"
              placeholder={`Filter ${paths.length} files`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {visible.length} files · {groups.length} groups · {staged.size}{" "}
              staged
            </p>
          </div>
          <nav
            aria-label="Changed files"
            className="min-h-0 flex-1 overflow-y-auto px-2 pb-6"
          >
            {mode === "grouped" ? (
              <GroupedFileTree
                key={example}
                paths={paths}
                visiblePaths={visible}
                statuses={statuses}
                selected={selected}
                onSelect={setSelected}
              />
            ) : (
              <FileTree
                key={example}
                paths={visible}
                allPaths={paths}
                marks={{}}
                statuses={statuses}
                selected={selected}
                defaultExpanded
                onSelect={setSelected}
              />
            )}
            {!visible.length && (
              <p className="p-4 text-sm text-muted-foreground">
                No matching files.
              </p>
            )}
          </nav>
        </aside>
        <section className="min-w-0 flex-1 overflow-auto p-8">
          <p className="mb-2 text-xs text-muted-foreground">SELECTED FILE</p>
          <h2 className="text-xl font-medium break-words">
            {selected.split("/").at(-1)}
          </h2>
          <p className="mt-2 font-mono text-xs break-all text-muted-foreground">
            {selected}
          </p>
          <div className="mt-8 max-w-xl rounded-3xl bg-muted/40 p-6">
            <h3 className="font-medium">A quieter way to browse changes</h3>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">
              Related paths share a section. Intermediate folders become small
              path labels instead of extra rows. Switch to Tree to compare with
              the complete hierarchy.
            </p>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">
              Try another project layout, filter by file name or path, collapse
              a group, or resize the sidebar. Groups are calculated from all
              changes and stay stable while filtering or staging.
            </p>
            <Button
              className="mt-5"
              variant="secondary"
              onClick={() =>
                setStaged((old) => {
                  const next = new Set(old)
                  if (next.has(selected)) next.delete(selected)
                  else next.add(selected)
                  return next
                })
              }
            >
              {staged.has(selected)
                ? "Unstage sample file"
                : "Stage sample file"}
            </Button>
            <p role="status" className="mt-3 text-xs text-muted-foreground">
              {staged.has(selected)
                ? "Sample file staged. No Git operation was performed."
                : "This preview does not read or modify your projects."}
            </p>
          </div>
        </section>
      </div>
    </main>
  )
}
