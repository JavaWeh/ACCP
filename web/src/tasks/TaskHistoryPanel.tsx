import { useI18n } from "../i18n";
import { Tabs, ProgressBar } from "@heroui/react";
import type { Doc } from "../api";
import { Json } from "../ui";

export function TaskHistoryPanel({
  task,
  runs,
  reports,
  reviews,
}: {
  task: Doc;
  runs: Doc[];
  reports: Doc[];
  reviews: Doc[];
}) {
  const { translate, stamp } = useI18n();
  return (
    <Tabs.Panel id="history">
      <h3>{translate("执行报告")}</h3>
      {reports.length ? (
        reports.map((r) => (
          <div className="timeline-item" key={r.id}>
            <strong>{r.kind}</strong>
            <small>{stamp(r.created_at)}</small>
            <p>{r.message || r.acceptance_report || r.error_code}</p>
            {r.progress_percent !== undefined && (
              <ProgressBar
                aria-label={translate("执行进度")}
                value={r.progress_percent}
              >
                <ProgressBar.Track>
                  <ProgressBar.Fill />
                </ProgressBar.Track>
              </ProgressBar>
            )}
          </div>
        ))
      ) : (
        <p className="text-sm leading-6 text-slate-600">
          {translate("暂无执行报告。")}
        </p>
      )}
      <h3>{translate("人工验收记录")}</h3>
      {reviews.length ? (
        reviews.map((r) => (
          <div className="timeline-item" key={r.id}>
            <strong>
              {r.decision === "ACCEPT" ? translate("接受") : translate("退回")}{" "}
              · {r.reviewed_by_user_id}
            </strong>
            <small>{stamp(r.created_at)}</small>
            <p>{r.reason}</p>
          </div>
        ))
      ) : (
        <p className="text-sm leading-6 text-slate-600">
          {translate("暂无验收记录。")}
        </p>
      )}
      <details>
        <summary>{translate("任务与执行来源")}</summary>
        <Json data={{ task, runs }} />
      </details>
    </Tabs.Panel>
  );
}
