import type { ReactNode } from "react"

export function WizardColumns({
  left,
  right,
  notice,
}: {
  left: ReactNode
  right: ReactNode
  notice: ReactNode
}) {
  return (
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(280px,0.58fr)_minmax(0,1fr)] overflow-hidden">
      <div className="min-h-0 min-w-0 overflow-x-hidden overflow-y-auto border-r p-7 max-[1000px]:p-5">
        {left}
      </div>
      <div className="min-h-0 min-w-0 overflow-x-hidden overflow-y-auto p-3">
        <div className="flex min-h-full flex-col items-center justify-between gap-10 rounded-3xl bg-muted/50 px-6 pt-12 pb-10 max-[1100px]:px-5 max-[1000px]:pt-7 max-[1000px]:pb-6">
          {right}
          {notice}
        </div>
      </div>
    </div>
  )
}
