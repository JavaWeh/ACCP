// Saved named filter views for the task list (F7 / B2). localStorage-first:
// there is no server-side preference store, so views persist per browser, keyed
// by project. Each view stores the serialized task-list search string so applying
// a view reuses parseTaskListSearch's normalization instead of trusting raw state.

export type SavedView = { name: string; search: string };

export const MAX_SAVED_VIEWS = 20;
export const SAVED_VIEWS_KEY_PREFIX = "accp.task-views.";

export function savedViewsKey(projectId: string): string {
  return SAVED_VIEWS_KEY_PREFIX + projectId;
}

/** Parse stored JSON into views; tolerate corruption (returns [] on any issue),
 *  drop malformed/blank/duplicate (case-insensitive) names, cap at MAX. */
export function parseSavedViews(raw: string | null): SavedView[] {
  if (!raw) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const views: SavedView[] = [];
  for (const entry of data) {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof (entry as { name?: unknown }).name !== "string" ||
      typeof (entry as { search?: unknown }).search !== "string"
    )
      continue;
    const name = (entry as { name: string }).name.trim();
    if (!name) continue;
    if (views.some((v) => v.name.toLowerCase() === name.toLowerCase())) continue;
    views.push({ name, search: (entry as { search: string }).search });
    if (views.length >= MAX_SAVED_VIEWS) break;
  }
  return views;
}

export function serializeSavedViews(views: SavedView[]): string {
  return JSON.stringify(views);
}

/** Add a view, replacing any existing one with the same (trimmed, case-insensitive)
 *  name, keeping at most MAX_SAVED_VIEWS (oldest dropped). */
export function upsertSavedView(
  views: SavedView[],
  name: string,
  search: string,
): SavedView[] {
  const trimmed = name.trim();
  const rest = views.filter(
    (v) => v.name.toLowerCase() !== trimmed.toLowerCase(),
  );
  return [...rest, { name: trimmed, search }].slice(-MAX_SAVED_VIEWS);
}

export function removeSavedView(views: SavedView[], name: string): SavedView[] {
  const target = name.trim().toLowerCase();
  return views.filter((v) => v.name.toLowerCase() !== target);
}

export function findSavedView(
  views: SavedView[],
  name: string,
): SavedView | undefined {
  const target = name.trim().toLowerCase();
  return views.find((v) => v.name.toLowerCase() === target);
}

export function readSavedViews(projectId: string): SavedView[] {
  try {
    return parseSavedViews(localStorage.getItem(savedViewsKey(projectId)));
  } catch {
    return [];
  }
}

export function writeSavedViews(projectId: string, views: SavedView[]): void {
  try {
    localStorage.setItem(savedViewsKey(projectId), serializeSavedViews(views));
  } catch {
    // Private mode / quota / unavailable storage: views are best-effort.
  }
}
