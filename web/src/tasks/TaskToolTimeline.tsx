import { useI18n } from "../i18n";
import { Tabs } from "@heroui/react";
import { useEffect, useState } from "react";
import type { Doc } from "../api";
import { short } from "../api";
import type { Workspace } from "../main";
import { Badge, Empty, Message } from "../ui";
import { routePath } from "../routing";

/**
 * Time-ordered copy of a Run's tool invocations (ascending by `created_at`, id
 * as a stable tie-breaker). Pure so the ordering is unit-testable without a DOM
 * (see tests/toolTimeline.spec.ts).
 */
export function sortInvocations(items: Doc[]): Doc[] {
  return [...items].sort((a, b) => {
    const at = String(a.created_at || "");
    const bt = String(b.created_at || "");
    if (at !== bt) return at < bt ? -1 : 1;
    return String(a.id) < String(b.id) ? -1 : 1;
  });
}

/**
 * Deep-link to the approval centre focused on one approval (reuses O-W11's
 * `?approval=:id` consumer in Approvals.tsx). Pure for testing.
 */
export function approvalLink(projectID: string, approvalID: string): string {
  return `${routePath({ projectID, page: "approvals" })}?approval=${encodeURIComponent(approvalID)}`;
}

export function TaskToolTimeline({
  w,
  runID,
  live,
}: {
  w: Workspace;
  runID?: string;
  live?: string;
}) {
  const { translate, label, stamp } = useI18n();
  const [invocations, setInvocations] = useState<Doc[]>([]);
  const [error, setError] = useState<unknown>();

  // Refetch on run change and on every F1 "live" pulse (SSE push or the 10s
  // polling fallback both bump `live`). Debounced and guarded so overlapping
  // pulses never race a stale response onto the timeline.
  useEffect(() => {
    if (!runID) {
      setInvocations([]);
      return;
    }
    let active = true;
    const timer = setTimeout(() => {
      w.api
        .all(`/task-runs/${runID}/tool-invocations`)
        .then((items) => {
          if (active) {
            setInvocations(sortInvocations(items));
            setError(undefined);
          }
        })
        .catch((cause) => {
          if (active) setError(cause);
        });
    }, 300);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [w.api, runID, live]);

  // Known terminal/interruption reasons get an explanatory sentence; anything
  // else falls back to the raw code so the surface never hides new reasons.
  const reasonText = (code: string): string => {
    switch (code) {
      case "EXTERNAL_OUTCOME_UNKNOWN":
        return translate("未能确认外部执行结果，需人工对账。");
      case "WORKER_INTERRUPTED":
        return translate("执行进程中断，结果待核对。");
      case "AUTHORITY_OR_BINDING_CHANGED":
        return translate("授权或绑定在执行前发生变化，操作已取消。");
      default:
        return code;
    }
  };

  return (
    <Tabs.Panel id="tools">
      <h3>{translate("工具调用时间线")}</h3>
      <p className="mb-4 text-sm leading-6 text-slate-600">
        {translate(
          "按时间顺序展示本次运行的工具调用状态，实时更新；此处仅供查看，不包含执行或重试操作。",
        )}
      </p>
      {error !== undefined && <Message error={error} />}
      {!runID ? (
        <Empty title={translate("尚无执行记录")}>
          {translate("任务开始执行后，这里会显示该运行的工具调用。")}
        </Empty>
      ) : invocations.length ? (
        invocations.map((i) => {
          const toolName =
            w.tools.find((t) => t.id === i.binding?.tool_id)?.name ||
            i.binding?.tool_id;
          return (
            <div className="timeline-item" key={i.id}>
              <strong>{toolName}</strong>
              <Badge value={i.status} />
              <small>{short(i.id)}</small>
              {i.binding?.resource_id && (
                <p>
                  {i.binding.resource_id}
                  {i.binding.resource_version
                    ? ` · ${i.binding.resource_version}`
                    : ""}
                </p>
              )}
              <p className="text-sm text-slate-600">
                {translate("下单 {time}", { time: stamp(i.created_at) })}
                {i.started_at &&
                  ` · ${translate("开始 {time}", { time: stamp(i.started_at) })}`}
                {i.completed_at &&
                  ` · ${translate("完成 {time}", { time: stamp(i.completed_at) })}`}
              </p>
              {i.error_code && (
                <p className="text-sm text-slate-600">
                  {reasonText(String(i.error_code))}
                </p>
              )}
              {i.status === "UNKNOWN" && (
                <p className="text-sm font-medium text-amber-700">
                  {translate("需人工对账")}
                </p>
              )}
              {i.approval_id && (
                <a
                  href={approvalLink(w.project.id, String(i.approval_id))}
                  className="text-sm font-medium text-indigo-700 underline-offset-2 hover:underline"
                >
                  {i.status === "AWAITING_APPROVAL"
                    ? translate("前往审批")
                    : translate("查看关联审批")}
                </a>
              )}
            </div>
          );
        })
      ) : (
        <Empty title={translate("本次运行暂无工具调用")}>
          {translate("当代理发起受治理的工具操作后，会按时间顺序出现在这里。")}
        </Empty>
      )}
    </Tabs.Panel>
  );
}
