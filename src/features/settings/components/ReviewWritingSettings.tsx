"use client"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { writingCommands } from "../services/writing.commands"
import { errorMessage } from "@/lib/desktop/review.commands"
import type {
  ReviewWritingProfile,
  ReviewWritingStyle,
} from "@/lib/desktop/contracts.generated"
const defaultProfile: ReviewWritingProfile = {
  style: "essential",
  instructions: "",
}
export function ReviewWritingSettings({
  repositoryId,
}: {
  repositoryId?: string
}) {
  const [profile, setProfile] = useState<ReviewWritingProfile>(defaultProfile)
  const [inherit, setInherit] = useState(Boolean(repositoryId))
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState("")
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    let alive = true
    writingCommands
      .get(repositoryId)
      .then((value) => {
        if (!alive) return
        setProfile(value ?? defaultProfile)
        setInherit(Boolean(repositoryId) && !value)
      })
      .catch((e) => {
        if (alive) setError(errorMessage(e))
      })
      .finally(() => {
        if (alive) setBusy(false)
      })
    return () => {
      alive = false
    }
  }, [repositoryId])
  async function save() {
    setBusy(true)
    setError("")
    setSaved(false)
    try {
      await writingCommands.save(repositoryId, inherit ? null : profile)
      setSaved(true)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="space-y-4">
      <div>
        <h3 className="text-sm font-medium">Review writing</h3>
        <p className="text-xs text-muted-foreground">
          Rev writes one document per step. Changes apply to the next
          preparation or update. Saved privately on this computer.
        </p>
      </div>
      <RadioGroup
        aria-label="Review writing style"
        value={inherit ? "inherit" : profile.style}
        disabled={busy}
        onValueChange={(value) => {
          setSaved(false)
          setInherit(value === "inherit")
          if (["essential", "explained", "technical", "custom"].includes(value))
            setProfile((p) => ({ ...p, style: value as ReviewWritingStyle }))
        }}
      >
        {(repositoryId
          ? ["inherit", "essential", "explained", "technical", "custom"]
          : ["essential", "explained", "technical", "custom"]
        ).map((style) => (
          <label key={style} className="flex items-center gap-3 text-sm">
            <RadioGroupItem value={style} />
            {style === "inherit"
              ? "Use application setting"
              : style[0].toUpperCase() + style.slice(1)}
          </label>
        ))}
      </RadioGroup>
      {!inherit && profile.style === "custom" && (
        <Textarea
          aria-label="Custom review writing instructions"
          placeholder="What should Rev explain in your review documents?"
          value={profile.instructions}
          disabled={busy}
          onChange={(e) => {
            setProfile((p) => ({ ...p, instructions: e.target.value }))
            setSaved(false)
          }}
        />
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button
        size="sm"
        disabled={
          busy ||
          (!inherit &&
            profile.style === "custom" &&
            !profile.instructions.trim())
        }
        onClick={() => void save()}
      >
        Save writing preferences
      </Button>
      {saved && (
        <p role="status" className="text-xs text-muted-foreground">
          Saved for the next preparation.
        </p>
      )}
    </section>
  )
}
