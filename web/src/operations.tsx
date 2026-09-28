import { useEffect, useState } from "react";
import type { Workspace } from "./main";
import type { Doc, Page } from "./api";
import { useI18n } from "./i18n";
import { Button, Empty, Field, Form, Input, Json, Message, text } from "./ui";

export function Operations({ w }: { w: Workspace }) {
  const { translate: t, number, stamp, label } = useI18n();
  const [diagnostics, setDiagnostics] = useState<Doc>();
  const [failures, setFailures] = useState<Page>({ items: [] });
  const [operations, setOperations] = useState<Page>({ items: [] });
  const [recovery, setRecovery] = useState<Page>({ items: [] });
  const [error, setError] = useState<unknown>();
  const [cursor, setCursor] = useState("");
  const [operationCursor, setOperationCursor] = useState("");
  const [recoveryCursor, setRecoveryCursor] = useState("");
  const admin = w.roles.includes("ADMIN");
  async function refresh() {
    if (!admin) return;
    const [d, f, o, r] = await Promise.all([
      w.api.call(`/projects/${w.project.id}/diagnostics`),
      w.api.call<Page>(
        `/projects/${w.project.id}/event-failures?limit=25&cursor=${encodeURIComponent(cursor)}`,
      ),
      w.api.call<Page>(
        `/projects/${w.project.id}/tool-invocations?limit=25&cursor=${encodeURIComponent(operationCursor)}`,
      ),
      w.api.call<Page>(
        `/projects/${w.project.id}/recovery-items?limit=25&cursor=${encodeURIComponent(recoveryCursor)}`,
      ),
    ]);
    setDiagnostics(d);
    setFailures(f);
    setOperations(o);
    setRecovery(r);
    setError(undefined);
  }
  useEffect(() => {
    refresh().catch(setError);
  }, [w.api, w.project.id, admin, cursor, operationCursor, recoveryCursor]);
  function exportDiagnostics() {
    if (!diagnostics) return;
    const data = {
      schema_version: 1,
      project_id: w.project.id,
      captured_at: new Date().toISOString(),
      diagnostics: {
        maintenance: diagnostics.maintenance,
        outbox_pending: diagnostics.outbox_pending,
        event_failures: diagnostics.event_failures,
        unknown_operations: diagnostics.unknown_operations,
        pending_approvals: diagnostics.pending_approvals,
        expired_leases: diagnostics.expired_leases,
        recovery_pending: diagnostics.recovery_pending,
      },
      failures: failures.items.map((event) => ({
        id: event.id,
        event_type: event.event_type,
        publish_attempts: event.publish_attempts,
        consume_attempts: event.consume_attempts,
        failed_at: event.failed_at,
      })),
      operations: operations.items.map((op) => ({
        id: op.id,
        status: op.status,
      })),
      recovery: recovery.items.map((item) => ({
        id: item.id,
        kind: item.kind,
        resource_id: item.resource_id,
        resolved_at: item.resolved_at,
      })),
      more_pages: Boolean(
        failures.next_cursor || operations.next_cursor || recovery.next_cursor,
      ),
    };
    const link = document.createElement("a");
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
    );
    link.href = url;
    link.download = `accp-diagnostics-${w.project.id.replace(/[^a-zA-Z0-9_-]/g, "_")}-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  if (!admin) return <Empty title={t("需要项目管理员权限")} />;
  const metrics = diagnostics
    ? [
        { key: "outbox_pending", name: t("待投递事件") },
        { key: "event_failures", name: t("失败事件") },
        { key: "unknown_operations", name: t("待核对操作") },
        { key: "pending_approvals", name: t("待处理审批") },
        { key: "expired_leases", name: t("过期执行租约") },
        { key: "recovery_pending", name: t("待恢复事项") },
      ]
    : [];
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm text-slate-600">
            {t("查看项目运行状态，处理需要人工核对的异常。")}
          </p>
          {diagnostics && (
            <p className="mt-2 text-xs text-slate-500">
              {t("检查时间：{time}", { time: stamp(diagnostics.checked_at) })}
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onPress={() => refresh().catch(setError)}>
            {t("刷新诊断")}
          </Button>
          <Button
            variant="outline"
            isDisabled={!diagnostics}
            onPress={exportDiagnostics}
          >
            {t("导出诊断")}
          </Button>
        </div>
      </div>
      {error !== undefined && <Message error={error} />}
      {!diagnostics ? (
        <Empty title={t("正在加载诊断")} />
      ) : (
        <>
          {diagnostics.maintenance && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-amber-900">
              {t("系统处于维护模式，新的写入暂不可用。")}
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {metrics.map((metric) => (
              <div
                key={metric.key}
                className="rounded-xl border border-slate-200 bg-white p-5 shadow-xs"
              >
                <p className="text-sm text-slate-600">{metric.name}</p>
                <strong
                  className={`mt-2 block text-3xl ${Number(diagnostics[metric.key]) ? "text-amber-700" : "text-slate-900"}`}
                >
                  {number(Number(diagnostics[metric.key] || 0))}
                </strong>
              </div>
            ))}
          </div>
        </>
      )}
      <section className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6">
        <h2 className="text-lg font-semibold">{t("失败事件")}</h2>
        <p className="mt-1 text-sm text-slate-600">
          {t("先确认失败原因，再决定是否重新投递。")}
        </p>
        {!failures.items.length && <Empty title={t("没有失败事件")} />}
        {failures.items.map((event) => (
          <article
            key={event.id}
            className="mt-4 rounded-lg border border-slate-200 p-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="m-0 text-sm font-semibold">
                {event.event_type || t("未知事件")}
              </h3>
              <span className="text-xs text-slate-500">
                {stamp(event.failed_at)}
              </span>
            </div>
            <p className="mt-2 text-sm text-amber-800">
              {event.consume_error ||
                event.publish_error ||
                t("需要人工核对失败原因")}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              {t("已尝试 {count} 次", {
                count: Number(
                  event.consume_attempts || event.publish_attempts || 0,
                ),
              })}
            </p>
            <details className="mt-3">
              <summary>{t("技术详情")}</summary>
              <Json data={event} />
            </details>
            <details className="mt-3">
              <summary>{t("授权重放")}</summary>
              <p className="mt-2 text-sm text-slate-600">
                {t("请先核对事件处理结果，避免重复执行外部操作。")}
              </p>
              <Form
                submit={t("确认重放")}
                action={async (data) => {
                  await w.api.call(
                    `/projects/${w.project.id}/events/${event.id}/replay`,
                    { reason: text(data, "reason") },
                  );
                  await refresh();
                }}
              >
                <Field label={t("重放原因")}>
                  <Input name="reason" required maxLength={2000} />
                </Field>
              </Form>
            </details>
          </article>
        ))}
        <div className="mt-4 flex gap-2">
          <Button
            variant="outline"
            isDisabled={!cursor}
            onPress={() => setCursor("")}
          >
            {t("返回首页")}
          </Button>
          <Button
            variant="outline"
            isDisabled={!failures.next_cursor}
            onPress={() => setCursor(failures.next_cursor || "")}
          >
            {t("下一页")}
          </Button>
        </div>
      </section>
      <section className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6">
        <h2 className="text-lg font-semibold">{t("操作核对")}</h2>
        <p className="mt-1 text-sm text-slate-600">
          {t("结果不明的外部操作必须先查询，不会自动重试。")}
        </p>
        {!operations.items.length && <Empty title={t("没有工具操作")} />}
        {operations.items.map((op) => (
          <article
            key={op.id}
            className="mt-4 rounded-lg border border-slate-200 p-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="m-0 text-sm font-semibold">
                {w.tools.find((tool) => tool.id === op.binding?.tool_id)
                  ?.name ||
                  op.binding?.tool_id ||
                  t("工具操作")}
              </h3>
              <span className="text-sm">{label(op.status)}</span>
            </div>
            <p className="mt-2 text-xs text-slate-500">
              {stamp(op.created_at)}
            </p>
            <details className="mt-3">
              <summary>{t("技术详情")}</summary>
              <Json data={op} />
            </details>
            {op.status === "UNKNOWN" && (
              <details className="mt-3">
                <summary>{t("查询外部结果并核对")}</summary>
                <Form
                  submit={t("确认查询结果")}
                  action={async (data) => {
                    await w.api.call(
                      `/tool-invocations/${op.id}/reconcile`,
                      { reason: text(data, "reason") },
                      op.version,
                    );
                    await refresh();
                  }}
                >
                  <Field label={t("核对原因")}>
                    <Input name="reason" required maxLength={2000} />
                  </Field>
                </Form>
              </details>
            )}
          </article>
        ))}
        <div className="mt-4 flex gap-2">
          <Button
            variant="outline"
            isDisabled={!operationCursor}
            onPress={() => setOperationCursor("")}
          >
            {t("返回首页")}
          </Button>
          <Button
            variant="outline"
            isDisabled={!operations.next_cursor}
            onPress={() => setOperationCursor(operations.next_cursor || "")}
          >
            {t("下一页")}
          </Button>
        </div>
      </section>
      <section className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6">
        <h2 className="text-lg font-semibold">{t("待恢复事项")}</h2>
        <p className="mt-1 text-sm text-slate-600">
          {t("先核对外部结果，再由运维人员按恢复手册留证处理。")}
        </p>
        {!recovery.items.length && <Empty title={t("没有待恢复事项")} />}
        {recovery.items.map((item) => (
          <article
            key={item.id}
            className="mt-4 rounded-lg border border-slate-200 p-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <strong>{label(item.kind)}</strong>
              <span className="text-sm">
                {item.resolved_at ? t("已处理") : t("等待处理")}
              </span>
            </div>
            <p className="mt-2 break-all text-xs text-slate-600">
              {item.resource_id}
            </p>
          </article>
        ))}
        <div className="mt-4 flex gap-2">
          <Button
            variant="outline"
            isDisabled={!recoveryCursor}
            onPress={() => setRecoveryCursor("")}
          >
            {t("返回首页")}
          </Button>
          <Button
            variant="outline"
            isDisabled={!recovery.next_cursor}
            onPress={() => setRecoveryCursor(recovery.next_cursor || "")}
          >
            {t("下一页")}
          </Button>
        </div>
      </section>
    </div>
  );
}
