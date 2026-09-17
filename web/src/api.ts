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
  actor = "";
  private pending = new Map<
    string,
    { key: string; body: string; version?: number; started: number }
  >();
  constructor(
    public token: string,
    private onExpired: () => void,
  ) {}
  async call<T = Doc>(
    path: string,
    body?: unknown,
    version?: number,
  ): Promise<T> {
    const storage = `accp.pending:${this.actor}:${path}`;
    let pending = body === undefined ? undefined : this.pending.get(path);
    if (body !== undefined && this.actor && !pending) {
      try {
        const saved = sessionStorage.getItem(storage);
        if (saved) pending = JSON.parse(saved);
      } catch {
        /* Storage may be disabled; retain this session's in-memory key. */
      }
    }
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    if (
      pending &&
      (!pending.started || Date.now() - pending.started >= 23 * 60 * 60 * 1000)
    ) {
      throw new Error(
        "该提交已接近幂等记录保留期限。请由管理员核对审计和资源结果，确认后再发起新操作。",
      );
    }
    if (
      body !== undefined &&
      pending &&
      (pending.body !== encoded || pending.version !== version)
    ) {
      throw new PendingSubmission(() =>
        this.call(path, JSON.parse(pending!.body), pending!.version),
      );
    }
    if (body !== undefined && !pending) {
      pending = {
        key: crypto.randomUUID(),
        body: encoded!,
        version,
        started: Date.now(),
      };
      this.pending.set(path, pending);
      try {
        if (this.actor)
          sessionStorage.setItem(storage, JSON.stringify(pending));
      } catch {
        /* Memory remains authoritative in this tab. */
      }
    }
    const clear = () => {
      if (body === undefined) return;
      this.pending.delete(path);
      try {
        if (this.actor) sessionStorage.removeItem(storage);
      } catch {
        /* Storage unavailable. */
      }
    };
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Idempotency-Key"] = pending!.key;
    }
    if (version !== undefined) headers["If-Match"] = `"${version}"`;
    let res: Response;
    let data: any;
    try {
      res = await fetch(`/api/v1${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers,
        body: encoded,
        redirect: "error",
        signal: AbortSignal.timeout(20000),
      });
      data = await res.json();
    } catch (error) {
      if (pending)
        throw new PendingSubmission(() =>
          this.call(path, JSON.parse(pending!.body), pending!.version),
        );
      throw error;
    }
    if (!res.ok) {
      if (res.status < 500) clear();
      if (res.status === 401) this.onExpired();
      if (res.status === 412) {
        let current: unknown;
        try {
          current = await this.call(path.slice(0, path.lastIndexOf("/")));
        } catch {
          current = "重新读取失败，请刷新资源后再决定如何修改。";
        }
        throw new VersionConflict(body, current, data.trace_id);
      }
      if (res.status >= 500 && pending)
        throw new PendingSubmission(() =>
          this.call(path, JSON.parse(pending!.body), pending!.version),
        );
      throw new ApiError(res.status, data.code, data.detail, data.trace_id);
    }
    clear();
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
export class PendingSubmission extends Error {
  retry: () => Promise<unknown>;
  constructor(action: () => Promise<unknown>) {
    super("提交结果尚未确认。请重试原请求确认结果，再发起其他修改。");
    let completed: Promise<unknown> | undefined;
    this.retry = () =>
      (completed ||= action().catch((error) => {
        completed = undefined;
        throw error;
      }));
  }
}
export class VersionConflict extends ApiError {
  constructor(
    public submitted: unknown,
    public current: unknown,
    trace: string,
  ) {
    super(
      412,
      "VERSION_CONFLICT",
      "资源已有新版本。请比较提交内容与当前内容，重新编辑后提交。",
      trace,
    );
  }
}
export const short = (value: string | undefined) =>
  value ? value.slice(0, 8) + "…" + value.slice(-6) : "—";
