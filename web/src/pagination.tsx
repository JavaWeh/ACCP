import { Button, Input, Select } from "./ui";
import { navigate, useLocationQuery } from "./navigation";

export function CollectionControls({
  page,
  next,
}: {
  page: string;
  next: string;
}) {
  const query = useLocationQuery();
  const change = (key: string, value: string) =>
    navigate({ [key]: value, cursor: undefined });
  return (
    <div
      className="mb-5 flex flex-wrap items-center gap-3"
      aria-label="列表分页"
    >
      {page !== "approvals" && (
        <Select
          aria-label="排序"
          value={query.get("sort") || "id"}
          onChange={(value) => change("sort", value)}
        >
          <option value="id">默认排序</option>
          <option value="title">标题</option>
          <option value="-updated">最近更新</option>
          <option value="updated">最早更新</option>
        </Select>
      )}
      {page === "tasks" && (
        <>
          <Select
            aria-label="任务状态"
            value={query.get("status") || ""}
            onChange={(value) => change("status", value)}
          >
            <option value="">所有状态</option>
            {[
              "DRAFT",
              "READY",
              "BLOCKED",
              "RUNNING",
              "IN_REVIEW",
              "DONE",
              "CANCELED",
            ].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
          <Select
            aria-label="归档筛选"
            value={query.get("archived") || "false"}
            onChange={(value) => change("archived", value)}
          >
            <option value="false">未归档</option>
            <option value="true">已归档</option>
            <option value="all">包括归档</option>
          </Select>
        </>
      )}
      {page !== "tasks" && page !== "approvals" && (
        <Input
          aria-label="服务端搜索"
          placeholder="搜索标题"
          value={query.get("search") || ""}
          onChange={(e) => change("search", e.target.value)}
        />
      )}
      <span className="text-sm text-slate-600">每页 25 条</span>
      <Button
        variant="ghost"
        isDisabled={!query.get("cursor")}
        onPress={() => navigate({ cursor: undefined })}
      >
        首页
      </Button>
      <Button
        variant="secondary"
        isDisabled={!next}
        onPress={() => navigate({ cursor: next })}
      >
        下一页
      </Button>
    </div>
  );
}
