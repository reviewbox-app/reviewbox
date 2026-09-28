export function illustrationDocument(source: string, token: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>
:root{color-scheme:light dark}body{margin:0;padding:16px;font:14px/1.6 system-ui;background:var(--background);color:var(--foreground);overflow-wrap:anywhere}*{box-sizing:border-box}svg{max-width:100%;height:auto}button,input,select{font:inherit}button:focus-visible,input:focus-visible{outline:2px solid var(--primary);outline-offset:2px}pre{white-space:pre-wrap;overflow-wrap:anywhere}@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
</style><script>(()=>{
const token=${JSON.stringify(token).replaceAll("<", "\\u003c")};
const send=(type,extra={})=>parent.postMessage({channel:"reviewbox-illustration",token,type,...extra},"*");
Object.defineProperty(window,"reviewboxIllustration",{value:Object.freeze({openReference:id=>send("reference",{id}),openTerm:id=>send("term",{id})}),writable:false});
addEventListener("message",event=>{if(event.source!==parent||event.data?.token!==token||event.data?.type!=="theme")return;for(const key of ["background","foreground","primary","muted","muted-foreground","border"]){const value=event.data.colors?.[key];if(typeof value==="string"&&value.length<200)document.documentElement.style.setProperty("--"+key,value)}document.documentElement.style.colorScheme=event.data.dark?"dark":"light"});
addEventListener("error",()=>send("error"));addEventListener("unhandledrejection",()=>send("error"));
addEventListener("DOMContentLoaded",()=>{send("ready");let last=0;new ResizeObserver(()=>{const height=Math.ceil(document.body.getBoundingClientRect().height);if(height!==last){last=height;send("resize",{height})}}).observe(document.body)});
})();</script></head><body>${source}</body></html>`
}
export function illustrationMessage(
  data: unknown,
  token: string
): { type: string; id?: string; height?: number } | null {
  if (!data || typeof data !== "object") return null
  const value = data as Record<string, unknown>
  if (value.channel !== "reviewbox-illustration" || value.token !== token)
    return null
  if (value.type === "ready" || value.type === "error")
    return { type: value.type }
  if (
    value.type === "resize" &&
    typeof value.height === "number" &&
    Number.isFinite(value.height)
  )
    return {
      type: "resize",
      height: Math.min(2000, Math.max(120, value.height)),
    }
  if (
    (value.type === "reference" || value.type === "term") &&
    typeof value.id === "string" &&
    /^[a-zA-Z0-9_-]{1,100}$/.test(value.id)
  )
    return { type: value.type, id: value.id }
  return null
}
