import { LocalizedError } from "./i18n";

export type Doc = { id: string; [key: string]: any };
export type Membership = {
  id: string;
  organization_id: string;
  project_id: string;
  display_name: string;
  roles: string[];
  membership_active?: boolean;
  account_active?: boolean;
  active: boolean;
  version: number;
};
export type Page<T = Doc> = { items: T[]; next_cursor?: string | null };
export type ResponseMetadata = { idempotencyReplayed: boolean };
export type CallOptions = {
  idempotencyKey?: string;
  uncertainResult?: boolean;
  onResponse?: (metadata: ResponseMetadata) => void;
};
export class UnknownResultError extends LocalizedError {
  constructor(cause: unknown) {
    super("请求结果未知，请勿重复提交。");
    this.cause = cause;
    this.name = "UnknownResultError";
  }
}
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
    options: CallOptions = {},
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
      const key =
        options.idempotencyKey ||
        this.uncertainWrites.get(operation) ||
        crypto.randomUUID();
      this.uncertainWrites.set(operation, key);
      headers["Idempotency-Key"] = key;
    }
    if (version !== undefined) headers["If-Match"] = `"${version}"`;
    let res: Response;
    try {
      res = await fetch(`/api/v1${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(20000),
      });
    } catch (cause) {
      if (body !== undefined && options.uncertainResult)
        throw new UnknownResultError(cause);
      throw cause;
    }
    if (body !== undefined && res.status < 500)
      this.uncertainWrites.delete(operation);
    if (res.status === 401) this.onExpired();
    let data;
    try {
      data = await res.json();
    } catch (cause) {
      if (
        body !== undefined &&
        options.uncertainResult &&
        (res.ok || res.status >= 500)
      ) {
        this.uncertainWrites.set(operation, headers["Idempotency-Key"]);
        throw new UnknownResultError(cause);
      }
      throw cause;
    }
    if (!res.ok) {
      throw new ApiError(res.status, data.code, data.detail, data.trace_id);
    }
    options.onResponse?.({
      idempotencyReplayed: res.headers.get("Idempotency-Replayed") === "true",
    });
    return data as T;
  }
  // Fetch a file response (redacted audit export) as a Blob, carrying the
  // bearer token the browser cannot attach to a plain anchor. Errors surface as
  // ApiError just like call(), so the UI shows the same "retry" affordance.
  async download(path: string): Promise<{ blob: Blob; filename: string }> {
    const res = await fetch(`/api/v1${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${this.token}` },
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
    if (res.status === 401) this.onExpired();
    if (!res.ok) {
      let data: { code?: string; detail?: string; trace_id?: string } = {};
      try {
        data = await res.json();
      } catch {
        // Non-JSON error body; fall back to status-only reporting.
      }
      throw new ApiError(
        res.status,
        data.code ?? "ERROR",
        data.detail ?? "",
        data.trace_id ?? "",
      );
    }
    const blob = await res.blob();
    const match = /filename="?([^"]+)"?/.exec(
      res.headers.get("Content-Disposition") ?? "",
    );
    return { blob, filename: match?.[1] ?? "audit-export" };
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
