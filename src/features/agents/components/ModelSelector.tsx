"use client"
import { useRef, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { ArrowReloadHorizontalIcon } from "@hugeicons/core-free-icons"
import { Button } from "@/components/ui/button"
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from "@/components/ui/combobox"
import { Spinner } from "@/components/ui/spinner"
import { selectedModel } from "../helpers/model.helpers"
import { useProviderModels } from "../hooks/useProviderModels"

export function ModelSelector({
  id,
  provider,
  executable,
  value,
  defaultLabel,
  disabled,
  onChange,
}: {
  id: string
  provider: string
  executable?: string
  value: string | null
  defaultLabel: string
  disabled?: boolean
  onChange: (value: string | null) => void
}) {
  const catalog = useProviderModels(provider, executable)
  const searchInput = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState("")
  const reload = () => {
    // Reload disables/removes its button. Keep keyboard focus inside the popup
    // so Escape cannot dismiss the parent settings dialog during discovery.
    searchInput.current?.focus()
    catalog.reload()
  }
  const models = catalog.models ?? []
  const selected = selectedModel(models, value)
  const unlisted = value && catalog.models !== null && !selected
  const options = [
    { id: "", name: defaultLabel, description: "" },
    ...models.map((model) => ({
      id: model.id,
      name: model.name,
      description: model.description,
    })),
    ...(value && !selected
      ? [
          {
            id: value,
            name: value,
            description: unlisted
              ? "Not listed by this harness"
              : "Current selection",
          },
        ]
      : []),
  ]
  const needle = query.trim().toLowerCase()
  const visible = options.filter((option) =>
    `${option.name} ${option.description} ${option.id}`
      .toLowerCase()
      .includes(needle)
  )
  return (
    <div className="min-w-0 space-y-1.5">
      <Combobox
        items={visible.map((option) => option.id)}
        filter={null}
        value={selected?.id ?? value ?? ""}
        open={catalog.open}
        onOpenChange={(open) => {
          setQuery("")
          catalog.onOpenChange(open)
        }}
        inputValue={query}
        onInputValueChange={setQuery}
        onValueChange={(next) => {
          if (next !== null) onChange(next || null)
        }}
      >
        <ComboboxTrigger
          id={id}
          aria-label="Model"
          disabled={disabled || !provider}
          render={
            <Button
              variant="secondary"
              className="w-full min-w-0 justify-between"
            />
          }
        >
          <span className="truncate">
            {selected?.name ?? value ?? defaultLabel}
          </span>
        </ComboboxTrigger>
        {/* WebKit cannot reliably stack backdrop filters over the Details dialog. */}
        <ComboboxContent className="min-w-0 bg-popover">
          <ComboboxInput
            ref={searchInput}
            aria-label="Search models"
            placeholder="Search models…"
            showTrigger={false}
          />
          <div className="flex items-center justify-between gap-2 px-3 py-1.5 text-xs text-muted-foreground">
            <span role="status" className="flex min-w-0 items-center gap-2">
              {catalog.loading && <Spinner className="size-3" />}
              {catalog.loading ? "Loading models…" : "Models from your harness"}
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Reload models"
              disabled={catalog.loading}
              onClick={reload}
            >
              <HugeiconsIcon icon={ArrowReloadHorizontalIcon} size={14} />
            </Button>
          </div>
          {catalog.error && (
            <div className="space-y-2 px-3 pb-2">
              <p
                role="alert"
                className="text-xs wrap-anywhere text-destructive"
              >
                {catalog.error}
              </p>
              <Button variant="secondary" size="sm" onClick={reload}>
                Try again
              </Button>
            </div>
          )}
          {catalog.models?.length === 0 && (
            <p className="px-3 pb-2 text-xs text-muted-foreground">
              No models returned by this harness.
            </p>
          )}
          <ComboboxEmpty>No matching models.</ComboboxEmpty>
          <ComboboxList>
            {(modelId: string) => {
              const option = options.find((item) => item.id === modelId)!
              return (
                <ComboboxItem
                  key={modelId}
                  value={modelId}
                  className="min-w-0 items-start"
                >
                  <span className="min-w-0 space-y-0.5 wrap-anywhere">
                    <span className="block">{option.name}</span>
                    {option.description && (
                      <span className="block text-xs text-muted-foreground">
                        {option.description}
                      </span>
                    )}
                  </span>
                </ComboboxItem>
              )
            }}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
      {unlisted && (
        <p className="text-xs text-muted-foreground">
          Not listed by this harness. Your saved model is kept.
        </p>
      )}
    </div>
  )
}
