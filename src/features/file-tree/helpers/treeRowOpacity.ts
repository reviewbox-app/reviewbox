/** One rule for the whole row, including Git colors, icons and badges. */
export function treeRowOpacity(
  staged: boolean,
  selected: boolean,
  ignored = false
) {
  return selected
    ? "opacity-100"
    : staged || ignored
      ? "opacity-50 hover:opacity-100 focus:opacity-100"
      : "opacity-80 hover:opacity-100 focus:opacity-100"
}
