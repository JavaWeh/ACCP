import { useEffect, useState } from "react";

export function navigate(
  values: Record<string, string | undefined>,
  reset = false,
) {
  const url = new URL(location.href);
  if (reset)
    for (const key of [...url.searchParams.keys()])
      if (key.endsWith("_cursor") || key === "audit_search")
        url.searchParams.delete(key);
  if ("task" in values && values.task !== url.searchParams.get("task"))
    for (const key of [
      "run_cursor",
      "review_cursor",
      "dependency_cursor",
      "evidence_cursor",
      "report_cursor",
    ])
      url.searchParams.delete(key);
  if (reset)
    for (const key of [
      "cursor",
      "search",
      "status",
      "owner",
      "sort",
      "archived",
      "task",
    ])
      url.searchParams.delete(key);
  for (const [key, value] of Object.entries(values))
    value ? url.searchParams.set(key, value) : url.searchParams.delete(key);
  history.pushState(null, "", url.pathname + url.search);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
export function useLocationQuery() {
  const [query, setQuery] = useState(() => location.search);
  useEffect(() => {
    const update = () => setQuery(location.search);
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);
  return new URLSearchParams(query);
}
