export type DiffLine = { kind: "same" | "add" | "remove"; text: string };

// A bounded line diff for review. Large documents retain the complete
// side-by-side view without allocating a quadratic diff matrix.
export function lineDiff(
  before: string,
  after: string,
): DiffLine[] | undefined {
  const oldLines = before ? before.split("\n") : [];
  const newLines = after ? after.split("\n") : [];
  const height = oldLines.length + 1;
  const width = newLines.length + 1;
  if (height * width > 200_000) return undefined;
  const lcs = new Uint16Array(height * width);
  for (let old = oldLines.length - 1; old >= 0; old--) {
    for (let next = newLines.length - 1; next >= 0; next--) {
      const index = old * width + next;
      lcs[index] =
        oldLines[old] === newLines[next]
          ? 1 + lcs[(old + 1) * width + next + 1]
          : Math.max(lcs[(old + 1) * width + next], lcs[index + 1]);
    }
  }
  const result: DiffLine[] = [];
  let old = 0;
  let next = 0;
  while (old < oldLines.length || next < newLines.length) {
    if (
      old < oldLines.length &&
      next < newLines.length &&
      oldLines[old] === newLines[next]
    ) {
      result.push({ kind: "same", text: oldLines[old++] });
      next++;
    } else if (
      next < newLines.length &&
      (old === oldLines.length ||
        lcs[old * width + next + 1] >= lcs[(old + 1) * width + next])
    ) {
      result.push({ kind: "add", text: newLines[next++] });
    } else {
      result.push({ kind: "remove", text: oldLines[old++] });
    }
  }
  return result;
}
