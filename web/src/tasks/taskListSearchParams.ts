export const SORT_FIELDS = ["updated_at", "title"] as const;
export const SORT_ORDERS = ["asc", "desc"] as const;

export type SortField = (typeof SORT_FIELDS)[number];
export type SortOrder = (typeof SORT_ORDERS)[number];

/** URL / UI filter state for the task list (cursor never included). */
export type TaskListQuery = {
  q: string;
  /** `me`, a member user id, or empty for all owners. */
  owner: string;
  /** Status enum, `archived`, or empty for all. */
  status: string;
  sort: SortField;
  order: SortOrder;
};

export const DEFAULT_TASK_LIST_QUERY: TaskListQuery = {
  q: "",
  owner: "",
  status: "",
  sort: "updated_at",
  order: "desc",
};

export function defaultOrderForSort(sort: SortField): SortOrder {
  return sort === "title" ? "asc" : "desc";
}

function isSortField(value: string | null): value is SortField {
  return SORT_FIELDS.includes(value as SortField);
}

function isSortOrder(value: string | null): value is SortOrder {
  return SORT_ORDERS.includes(value as SortOrder);
}

/** Parse location.search; illegal/missing sort|order normalize to defaults. */
export function parseTaskListSearch(search: string): {
  query: TaskListQuery;
  normalized: boolean;
} {
  const params = new URLSearchParams(
    search.startsWith("?") ? search.slice(1) : search,
  );
  const rawSort = params.get("sort");
  const rawOrder = params.get("order");
  let normalized = false;

  let sort: SortField = DEFAULT_TASK_LIST_QUERY.sort;
  let order: SortOrder = DEFAULT_TASK_LIST_QUERY.order;

  if (!isSortField(rawSort) || !isSortOrder(rawOrder)) {
    normalized = true;
    if (isSortField(rawSort) && !isSortOrder(rawOrder)) {
      sort = rawSort;
      order = defaultOrderForSort(rawSort);
    } else {
      sort = DEFAULT_TASK_LIST_QUERY.sort;
      order = DEFAULT_TASK_LIST_QUERY.order;
    }
  } else {
    sort = rawSort;
    order = rawOrder;
  }

  const archived = params.get("archived") === "true";
  const statusParam = params.get("status") || "";
  const status = archived ? "archived" : statusParam;

  const q = (params.get("q") || "").trim();
  const owner = params.get("owner") || "";

  return {
    query: { q, owner, status, sort, order },
    normalized,
  };
}

/** Serialize filters/sort for the URL — never cursor or limit. */
export function serializeTaskListSearch(query: TaskListQuery): string {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.owner) params.set("owner", query.owner);
  if (query.status === "archived") params.set("archived", "true");
  else if (query.status) params.set("status", query.status);
  params.set("sort", query.sort);
  params.set("order", query.order);
  const text = params.toString();
  return text ? `?${text}` : "";
}

export function taskListSearchEquals(
  a: TaskListQuery,
  b: TaskListQuery,
): boolean {
  return (
    a.q === b.q &&
    a.owner === b.owner &&
    a.status === b.status &&
    a.sort === b.sort &&
    a.order === b.order
  );
}

export function hasActiveFilters(query: TaskListQuery): boolean {
  return Boolean(query.q || query.owner || query.status);
}

/** Resolve URL owner (`me` or id) to the API `owner` query value. */
export function apiOwnerParam(owner: string, meId: string): string | undefined {
  if (!owner) return undefined;
  if (owner === "me") return meId;
  return owner;
}

/** Build GET query for `/projects/:id/tasks` — always includes sort + order. */
export function buildTaskListRequestParams(
  query: TaskListQuery,
  meId: string,
  cursor: string,
  limit = 25,
): URLSearchParams {
  const params = new URLSearchParams({
    limit: String(limit),
    sort: query.sort,
    order: query.order,
  });
  if (query.q) params.set("q", query.q);
  const owner = apiOwnerParam(query.owner, meId);
  if (owner) params.set("owner", owner);
  if (query.status === "archived") params.set("archived", "true");
  else if (query.status) params.set("status", query.status);
  if (cursor) params.set("cursor", cursor);
  return params;
}

export function writeTaskListUrl(
  query: TaskListQuery,
  mode: "push" | "replace",
): void {
  const next = `${location.pathname}${serializeTaskListSearch(query)}${location.hash}`;
  if (mode === "replace") history.replaceState(history.state, "", next);
  else history.pushState(history.state, "", next);
}
