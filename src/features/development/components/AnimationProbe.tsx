"use client"

import { useRef } from "react"
import { gsap } from "gsap"
import { useGSAP } from "@gsap/react"
import { motion, useReducedMotion } from "motion/react"

gsap.registerPlugin(useGSAP)

export function AnimationProbe({ count }: { count: number }) {
  const scope = useRef<HTMLDivElement>(null)
  const reduceMotion = useReducedMotion()

  useGSAP(
    () => {
      gsap.fromTo(
        "[data-gsap-probe]",
        { x: 0 },
        {
          x: count % 2 ? 32 : 0,
          duration: reduceMotion ? 0 : 0.25,
        }
      )
    },
    { scope, dependencies: [count, reduceMotion], revertOnUpdate: true }
  )

  return (
    <div
      ref={scope}
      className="flex h-12 items-center gap-12"
      aria-label="Animations"
    >
      <motion.div
        className="rounded-lg bg-primary px-3 py-1 text-xs text-primary-foreground"
        animate={{ scale: count % 2 ? 1.1 : 1 }}
        transition={{ duration: reduceMotion ? 0 : 0.2 }}
      >
        Motion
      </motion.div>
      <div
        data-gsap-probe
        className="rounded-lg bg-secondary px-3 py-1 text-xs"
      >
        GSAP
      </div>
    </div>
  )
}
