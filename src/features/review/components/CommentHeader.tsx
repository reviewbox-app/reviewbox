import { HugeiconsIcon } from "@hugeicons/react"
import { AiMagicIcon } from "@hugeicons/core-free-icons"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { authorOf, shortTime } from "../helpers/review.helpers"

/** RB/Comment header. An agent author always carries the "Suggestion" badge. */
export function CommentHeader({
  author,
  createdAt,
}: {
  author: string
  createdAt?: string | number
}) {
  const who = authorOf(author)
  return (
    <div className="flex items-center gap-2" title={author}>
      <Avatar size="sm">
        <AvatarFallback className="text-[10px]">
          {who.agent ? <HugeiconsIcon icon={AiMagicIcon} size={12} /> : "RV"}
        </AvatarFallback>
      </Avatar>
      <span className="text-sm font-medium">{who.name}</span>
      {who.agent && <Badge variant="secondary">Suggestion</Badge>}
      {createdAt !== undefined && (
        <span className="text-xs text-muted-foreground">
          {shortTime(createdAt)}
        </span>
      )}
    </div>
  )
}
