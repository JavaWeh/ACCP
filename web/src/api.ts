export type Doc = { id: string; [key: string]: any };
export type Membership = {
  id: string;
  organization_id: string;
  project_id: string;
  display_name: string;
  roles: string[];
  active: boolean;
  version: number;
};
export type Page<T = Doc> = { items: T[]; next_cursor?: string | null };
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    detail: string,
    public trace: string,
  ) {
    super(detail);
  }
}
export class API {
  private uncertainWrites = new Map<string, string>();
  constructor(
    public token: string,
    private onExpired: () => void,
  ) {}
  async call<T = Doc>(
    path: string,
    body?: unknown,
    version?: number,
  ): Promise<T> {
    const operation =
      body === undefined
        ? ""
        : `${path}\n${version ?? ""}\n${JSON.stringify(body)}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      const key = this.uncertainWrites.get(operation) || crypto.randomUUID();
      this.uncertainWrites.set(operation, key);
      headers["Idempotency-Key"] = key;
    }
    if (version !== undefined) headers["If-Match"] = `"${version}"`;
    const res = await fetch(`/api/v1${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    });
    const data = await res.json();
    if (body !== undefined && res.status < 500)
      this.uncertainWrites.delete(operation);
    if (!res.ok) {
      if (res.status === 401) this.onExpired();
      throw new ApiError(res.status, data.code, data.detail, data.trace_id);
    }
    return data as T;
  }
  async all<T = Doc>(path: string): Promise<T[]> {
    const result: T[] = [];
    let cursor = "";
    do {
      const page = await this.call<Page<T>>(
        `${path}${path.includes("?") ? "&" : "?"}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      result.push(...page.items);
      cursor = page.next_cursor || "";
    } while (cursor);
    return result;
  }
}
export const short = (value: string | undefined) =>
  value ? value.slice(0, 8) + "…" + value.slice(-6) : "—";
