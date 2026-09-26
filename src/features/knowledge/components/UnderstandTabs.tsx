import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"

export type UnderstandView = "files" | "tours" | "glossary"

/** Shared left-panel switch of the Understand space. */
export function UnderstandTabs({
  value,
  onChange,
}: {
  value: UnderstandView
  onChange: (value: UnderstandView) => void
}) {
  return (
    <Tabs
      value={value}
      onValueChange={(v) => onChange(v as UnderstandView)}
      className="px-2"
    >
      <TabsList variant="line" className="h-10">
        <TabsTrigger value="files">Files</TabsTrigger>
        <TabsTrigger value="tours">Tours</TabsTrigger>
        <TabsTrigger value="glossary">Glossary</TabsTrigger>
      </TabsList>
    </Tabs>
  )
}
