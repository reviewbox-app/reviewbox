"use client"

import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { AdvancedLanguageServerSettings } from "./AdvancedLanguageServerSettings"
import { LanguageServerCatalogueRow } from "../components/LanguageServerCatalogueRow"
import { useLanguageCatalogue } from "../hooks/useLanguageCatalogue"
import { catalogueCommands } from "../services/catalogue.commands"
import { LanguagePacksPanel } from "./LanguagePacksPanel"

export function LanguageServerSettingsPanel() {
  const state = useLanguageCatalogue()
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState("all")
  const [advanced, setAdvanced] = useState(false)
  const advancedPanel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (advanced) advancedPanel.current?.scrollIntoView({ block: "start" })
  }, [advanced])
  const entries = state.catalogue?.entries ?? []
  const available = entries.filter(
    (entry) =>
      state.recommended.has(entry.id) &&
      entry.supported &&
      !entry.installedVersion &&
      entry.status !== "installing"
  )
  const visible = entries.filter(
    (entry) =>
      (filter !== "installed" || entry.installedVersion) &&
      (filter !== "recommended" || state.recommended.has(entry.id)) &&
      `${entry.name} ${entry.languages.join(" ")}`
        .toLowerCase()
        .includes(query.toLowerCase())
  )
  const repositoryItems = state.repositories.length
    ? state.repositories.map((repository) => ({
        value: repository.id,
        label: repository.name,
      }))
    : [{ value: "", label: "No open project" }]
  return (
    <section className="space-y-4">
      <LanguagePacksPanel />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Label htmlFor="languages-project">Project</Label>
          <Select
            items={repositoryItems}
            value={state.repositoryId}
            onValueChange={(value) => {
              if (value !== null) {
                state.setRepositoryId(value)
              }
            }}
          >
            <SelectTrigger id="languages-project">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {repositoryItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button
          size="sm"
          variant="secondary"
          disabled={!available.length || state.busy.includes("recommended")}
          onClick={() =>
            void state.act("recommended", async () => {
              for (const entry of available)
                await catalogueCommands.install(entry.id)
            })
          }
        >
          Install recommended
        </Button>
      </div>
      <Input
        aria-label="Search languages"
        placeholder="Search languages or servers…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Tabs value={filter} onValueChange={setFilter}>
          <TabsList>
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="installed">Installed</TabsTrigger>
            <TabsTrigger value="recommended">Recommended</TabsTrigger>
          </TabsList>
        </Tabs>
        <Button
          size="xs"
          variant="ghost"
          aria-expanded={advanced}
          onClick={() => setAdvanced(!advanced)}
        >
          Custom executables
        </Button>
      </div>
      {state.error && (
        <Alert variant="faded" size="sm">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
      {advanced && (
        <div ref={advancedPanel}>
          <AdvancedLanguageServerSettings />
        </div>
      )}
      {!state.catalogue ? (
        <p className="text-sm text-muted-foreground">Loading languages…</p>
      ) : visible.length ? (
        <ul className="divide-y divide-border/50">
          {visible.map((entry) => (
            <LanguageServerCatalogueRow
              key={entry.id}
              entry={entry}
              recommended={state.recommended.has(entry.id)}
              busy={state.busy.includes(entry.id)}
              operation={state.catalogue?.operations.findLast(
                (operation) => operation.serverId === entry.id
              )}
              act={state.act}
              onCustomSetup={() => setAdvanced(true)}
            />
          ))}
        </ul>
      ) : (
        <p className="py-5 text-sm text-muted-foreground">
          No languages match this filter.
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Built-in tools download when first needed; additional language packs
        install on request. Tools stay in ReviewBox’s private data.
      </p>
    </section>
  )
}
