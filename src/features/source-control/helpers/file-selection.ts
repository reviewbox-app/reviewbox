export function selectFiles(
  current: ReadonlySet<string>,
  anchor: string,
  path: string,
  visible: string[],
  modifiers: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }
): Set<string> {
  const additive = modifiers.metaKey || modifiers.ctrlKey
  if (modifiers.shiftKey && visible.includes(anchor)) {
    const start = visible.indexOf(anchor)
    const end = visible.indexOf(path)
    if (end >= 0)
      return new Set([
        ...(additive ? current : []),
        ...visible.slice(Math.min(start, end), Math.max(start, end) + 1),
      ])
  }
  if (!additive) return new Set([path])
  const next = new Set(current)
  if (next.has(path)) next.delete(path)
  else next.add(path)
  return next
}
