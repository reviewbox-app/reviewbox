"use client"

import { useEffect, useRef, useState } from "react"
import {
  illustrationDocument,
  illustrationMessage,
} from "../helpers/illustration.helpers"
import { illustrationCommands } from "../services/illustration.commands"

export function ReviewIllustration({
  source,
  onReference,
  onTerm,
}: {
  source: string
  onReference: (id: string) => void
  onTerm: (id: string) => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  const handlers = useRef({ onReference, onTerm })
  useEffect(() => {
    handlers.current = { onReference, onTerm }
  }, [onReference, onTerm])
  const [visible, setVisible] = useState(false)
  const [url, setUrl] = useState<string>()
  const [height, setHeight] = useState(200)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true)
          observer.disconnect()
        }
      },
      { rootMargin: "240px" }
    )
    if (host.current) observer.observe(host.current)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (!visible) return
    let alive = true
    let id: string | undefined
    const token = crypto.randomUUID()
    const theme = () => {
      const style = getComputedStyle(document.documentElement)
      const colors = Object.fromEntries(
        [
          "background",
          "foreground",
          "primary",
          "muted",
          "muted-foreground",
          "border",
        ].map((key) => [key, style.getPropertyValue(`--${key}`).trim()])
      )
      frame.current?.contentWindow?.postMessage(
        {
          token,
          type: "theme",
          colors,
          dark: document.documentElement.classList.contains("dark"),
        },
        "*"
      )
    }
    const receive = (event: MessageEvent) => {
      if (!alive || event.source !== frame.current?.contentWindow) return
      const message = illustrationMessage(event.data, token)
      if (message?.type === "resize") setHeight(message.height!)
      if (message?.type === "ready") theme()
      if (message?.type === "error") setFailed(true)
      if (message?.type === "reference")
        handlers.current.onReference(message.id!)
      if (message?.type === "term") handlers.current.onTerm(message.id!)
    }
    window.addEventListener("message", receive)
    const observer = new MutationObserver(theme)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    })
    void illustrationCommands
      .register(illustrationDocument(source, token))
      .then((key) => {
        id = key
        if (alive) setUrl(illustrationCommands.url(key))
        else void illustrationCommands.release(key).catch(() => {})
      })
      .catch(() => {
        if (alive) setFailed(true)
      })
    return () => {
      alive = false
      window.removeEventListener("message", receive)
      observer.disconnect()
      if (id) void illustrationCommands.release(id).catch(() => {})
    }
  }, [visible, source])
  return (
    <div
      ref={host}
      className="not-prose my-5 min-h-32 overflow-hidden rounded-xl border"
    >
      {url && (
        <iframe
          ref={frame}
          src={url}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          title="Interactive review illustration"
          className="w-full border-0"
          style={{ height }}
        />
      )}
      {failed && (
        <p role="status" className="p-3 text-sm text-muted-foreground">
          This illustration could not render correctly.
        </p>
      )}
    </div>
  )
}
