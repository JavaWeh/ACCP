import { useMemo, useState } from "react";
import { useI18n } from "../i18n";
import { ApiError, type Doc } from "../api";
import type { Workspace } from "../main";
import { Button, Input, Modal, Select } from "../ui";
import { bulkSummary, runBulk, type BulkResult } from "./bulkActions";

// Bulk owner transfer: loop POST /tasks/{id}/transfer per selected task, each with
// its own If-Match version + Idempotency-Key + per-item audit (all handled by the
// endpoint / api.call). Partial failures are surfaced item-by-item so the user can
// retry only what failed.
export function BulkTransfer({
  w,
  tasks,
  close,
  onApplied,
}: {
  w: Workspace;
  tasks: Doc[];
  close: () => void;
  onApplied: (succeeded: string[], failed: string[]) => void;
}) {
  const { translate } = useI18n();
  // Freeze the selection at open time so the summary/title stay stable even after
  // the parent prunes succeeded items from its selection.
  const [snapshot] = useState(tasks);
  const [owner, setOwner] = useState("");
  const [reason, setReason] = useState("");
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<BulkResult[] | null>(null);

  const byId = useMemo(
    () => new Map(snapshot.map((t) => [t.id, t])),
    [snapshot],
  );
  const title = (id: string) => byId.get(id)?.title || id;
  const describe = (error: unknown) =>
    error instanceof ApiError
      ? `${error.code} · ${error.message}`
      : error instanceof Error
        ? error.message
        : String(error);

  const confirm = async () => {
    if (!owner || !reason.trim() || running) return;
    setRunning(true);
    const res = await runBulk(
      snapshot.map((t) => t.id),
      (id) =>
        w.api.call(
          `/tasks/${id}/transfer`,
          { owner_user_id: owner, reason: reason.trim() },
          byId.get(id)?.version,
        ),
    );
    setResults(res);
    setRunning(false);
    const { succeeded, failed } = bulkSummary(res);
    onApplied(
      succeeded,
      failed.map((f) => f.id),
    );
  };

  const summary = results && bulkSummary(results);

  return (
    <Modal
      title={translate("批量移交 {count} 个任务", { count: snapshot.length })}
      close={close}
      dismissable={!running}
    >
      {summary ? (
        <div className="flex flex-col gap-3">
          {summary.failed.length === 0 ? (
            <p className="text-sm text-green-700">
              {translate("全部移交成功")}
            </p>
          ) : (
            <>
              <p className="text-sm text-slate-700">
                {translate("成功 {ok} 项，失败 {fail} 项", {
                  ok: summary.succeeded.length,
                  fail: summary.failed.length,
                })}
              </p>
              <p className="text-sm font-medium text-slate-700">
                {translate("以下任务移交失败：")}
              </p>
              <ul className="flex flex-col gap-2">
                {summary.failed.map((f) => (
                  <li key={f.id} className="text-sm break-words">
                    <span className="font-semibold">{title(f.id)}</span>
                    <span className="block text-red-700">
                      {describe(f.error)}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className="flex justify-end">
            <Button variant="primary" onPress={close}>
              {translate("关闭")}
            </Button>
          </div>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void confirm();
          }}
          className="flex flex-col gap-4"
        >
          <p className="text-sm text-slate-600">
            {translate("将把选中的 {count} 个任务移交给同一位负责人。", {
              count: snapshot.length,
            })}
          </p>
          <Select
            aria-label={translate("新负责人")}
            value={owner}
            onChange={setOwner}
          >
            <option value="">{translate("新负责人")}</option>
            {w.members
              .filter((m) => m.active)
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.display_name || m.id}
                </option>
              ))}
          </Select>
          <Input
            aria-label={translate("移交原因")}
            placeholder={translate("移交原因")}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onPress={close} isDisabled={running}>
              {translate("取消")}
            </Button>
            <Button
              type="submit"
              variant="primary"
              aria-busy={running || undefined}
              isDisabled={running || !owner || !reason.trim()}
            >
              {running ? translate("移交中…") : translate("确认移交")}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
