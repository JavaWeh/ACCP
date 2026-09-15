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
  constructor(
    public token: string,
    private onExpired: () => void,
  ) {}
  async call<T = Doc>(
    path: string,
    body?: unknown,
    version?: number,
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Idempotency-Key"] = crypto.randomUUID();
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
export const labels: Record<string, string> = {
  DRAFT: "草稿",
  READY: "可执行",
  BLOCKED: "等待条件",
  RUNNING: "执行中",
  IN_REVIEW: "待验收",
  DONE: "已完成",
  CANCELED: "已取消",
  PENDING: "待审核",
  APPROVED: "已批准",
  REJECTED: "已退回",
  EXPIRED: "已过期",
  VERIFIED: "已核验",
  UNVERIFIED: "待核验",
  FAILED: "失败",
  ACCEPTED: "已接受",
  AWAITING_APPROVAL: "等待审批",
  SUCCEEDED: "成功",
  UNKNOWN: "结果待核对",
  LOST: "执行失联",
  ACTIVE: "有效",
  REVOKED: "已撤销",
  DENIED: "已拒绝",
  REQUIREMENT: "需求",
  API: "API 契约",
  DB_SCHEMA: "数据库结构",
  ADR: "架构决策",
  PROJECT_RULE: "项目规范",
  DOCUMENT: "文档",
  API_DOCUMENT: "API 文档",
  COMMIT: "Commit",
  PULL_REQUEST: "Pull Request",
  CODE_DIFF: "代码差异",
  SQL: "SQL",
  TEST_REPORT: "测试报告",
  ADMIN: "管理员",
  MEMBER: "成员",
  REVIEWER: "审核人",
  VIEWER: "只读成员",
  CANDIDATE: "候选版本",
  PUBLISHED: "已发布",
  READ_ONLY: "只读",
  HIGH: "需人工审批",
};
export const label = (value: string) => labels[value] || value;
export const short = (value: string | undefined) =>
  value ? value.slice(0, 8) + "…" + value.slice(-6) : "—";
export const stamp = (value?: string) =>
  value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";
