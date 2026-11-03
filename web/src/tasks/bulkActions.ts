// Bulk task actions (F7 / B2): loop an existing idempotent endpoint per selected
// task, preserving per-item Idempotency-Key + per-item audit (both handled by the
// endpoint/api.call). The loop is sequential so a partial failure is reported
// clearly and the caller can retry only the failed items.

export type BulkResult = { id: string; ok: boolean; error?: unknown };

export async function runBulk(
  ids: string[],
  perform: (id: string) => Promise<unknown>,
): Promise<BulkResult[]> {
  const results: BulkResult[] = [];
  for (const id of ids) {
    try {
      await perform(id);
      results.push({ id, ok: true });
    } catch (error) {
      results.push({ id, ok: false, error });
    }
  }
  return results;
}

export function bulkSummary(results: BulkResult[]): {
  succeeded: string[];
  failed: { id: string; error: unknown }[];
} {
  return {
    succeeded: results.filter((r) => r.ok).map((r) => r.id),
    failed: results
      .filter((r) => !r.ok)
      .map((r) => ({ id: r.id, error: r.error })),
  };
}
