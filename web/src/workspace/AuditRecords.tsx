import { useCallback, useEffect, useState } from "react";
import { Card, Table } from "@heroui/react";
import { useI18n } from "../i18n";
import type { API, Doc, Page } from "../api";
import { short } from "../api";
import {
  Button,
  Input,
  Badge,
  Empty,
  Json,
  Message,
  Modal,
  Select,
} from "../ui";

export type AuditFilters = {
  actor: string;
  task: string;
  action: string;
  from: string;
  to: string;
  project: string;
};

export const emptyAuditFilters: AuditFilters = {
  actor: "",
  task: "",
  action: "",
  from: "",
  to: "",
  project: "",
};

// auditQuery serializes a filter set into a server query string. The cursor is
// included only for "load more"; applying or clearing filters passes no cursor,
// which resets pagination on the server (US-11b). Pure so the reset rule is
// unit-testable without a backend.
export function auditQuery(
  filters: AuditFilters,
  opts: { cursor?: string; format?: string; limit?: number } = {},
): string {
  const p = new URLSearchParams();
  (Object.keys(filters) as (keyof AuditFilters)[]).forEach((k) => {
    if (filters[k]) p.set(k, filters[k]);
  });
  if (opts.limit) p.set("limit", String(opts.limit));
  if (opts.cursor) p.set("cursor", opts.cursor);
  if (opts.format) p.set("format", opts.format);
  const query = p.toString();
  return query ? `?${query}` : "";
}

// canExportAudit gates the export control on the ADMIN role. REVIEWER-only
// members can read the list but never see export (Q-N4=B).
export function canExportAudit(roles: string[]): boolean {
  return roles.includes("ADMIN");
}

export function AuditRecords({
  api,
  listPath,
  exportPath,
  canExport,
  projects,
}: {
  api: API;
  listPath: string;
  exportPath: string;
  canExport: boolean;
  projects?: Doc[];
}) {
  const { translate, stamp } = useI18n();
  const [draft, setDraft] = useState<AuditFilters>(emptyAuditFilters);
  const [applied, setApplied] = useState<AuditFilters>(emptyAuditFilters);
  const [rows, setRows] = useState<Doc[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<unknown>();
  const [selected, setSelected] = useState<Doc>();
  const [exporting, setExporting] = useState("");
  const [exportNote, setExportNote] = useState("");
  const [exportError, setExportError] = useState<unknown>();
  const [menuOpen, setMenuOpen] = useState(false);

  const load = useCallback(
    async (filters: AuditFilters, cur: string | null) => {
      setLoading(true);
      setError(undefined);
      try {
        const page = await api.call<Page>(
          `${listPath}${auditQuery(filters, { cursor: cur ?? undefined, limit: 50 })}`,
        );
        setRows((prev) => (cur ? [...prev, ...page.items] : page.items));
        setCursor(page.next_cursor ?? null);
        setLoaded(true);
      } catch (e) {
        setError(e);
      } finally {
        setLoading(false);
      }
    },
    [api, listPath],
  );

  useEffect(() => {
    load(emptyAuditFilters, null);
  }, [load]);

  function update(key: keyof AuditFilters, value: string) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }
  function apply() {
    setApplied(draft);
    setRows([]);
    setCursor(null);
    load(draft, null);
  }
  function clear() {
    setDraft(emptyAuditFilters);
    setApplied(emptyAuditFilters);
    setRows([]);
    setCursor(null);
    load(emptyAuditFilters, null);
  }
  async function runExport(format: string) {
    setMenuOpen(false);
    setExporting(format);
    setExportError(undefined);
    setExportNote("");
    try {
      const { blob, filename } = await api.download(
        `${exportPath}${auditQuery(applied, { format })}`,
      );
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setExportNote(
        translate("已开始下载脱敏审计（{format}）", {
          format: format.toUpperCase(),
        }),
      );
    } catch (e) {
      setExportError(e);
    } finally {
      setExporting("");
    }
  }

  return (
    <div className="grid gap-4">
      <p className="text-sm leading-6 text-slate-600">
        {translate(
          "查看操作者、责任人、执行依据和审核结果。导出内容已经脱敏。",
        )}
      </p>
      <div className="flex flex-wrap items-end gap-3">
        {projects && (
          <label className="grid gap-1 text-sm">
            {translate("项目")}
            <Select
              aria-label={translate("项目")}
              value={draft.project}
              onChange={(v) => update("project", v)}
            >
              <option value="">{translate("全部项目")}</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name ?? p.id}
                </option>
              ))}
            </Select>
          </label>
        )}
        <Input
          className="w-40"
          aria-label={translate("执行人")}
          placeholder={translate("执行人")}
          value={draft.actor}
          onChange={(e) => update("actor", e.target.value)}
        />
        <Input
          className="w-40"
          aria-label={translate("任务 ID")}
          placeholder={translate("任务 ID")}
          value={draft.task}
          onChange={(e) => update("task", e.target.value)}
        />
        <Input
          className="w-48"
          aria-label={translate("动作")}
          placeholder={translate("动作")}
          value={draft.action}
          onChange={(e) => update("action", e.target.value)}
        />
        <label className="grid gap-1 text-sm">
          {translate("从")}
          <input
            type="date"
            className="rounded border p-2"
            aria-label={translate("从")}
            value={draft.from}
            onChange={(e) => update("from", e.target.value)}
          />
        </label>
        <label className="grid gap-1 text-sm">
          {translate("至")}
          <input
            type="date"
            className="rounded border p-2"
            aria-label={translate("至")}
            value={draft.to}
            onChange={(e) => update("to", e.target.value)}
          />
        </label>
        <Button variant="outline" onPress={apply} isDisabled={loading}>
          {translate("应用筛选")}
        </Button>
        <Button variant="ghost" onPress={clear} isDisabled={loading}>
          {translate("清除筛选")}
        </Button>
        {canExport && (
          <div className="relative ml-auto">
            <Button
              variant="primary"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-busy={exporting !== ""}
              isDisabled={exporting !== ""}
              onPress={() => setMenuOpen((o) => !o)}
            >
              {exporting ? translate("正在导出…") : translate("导出") + " ▾"}
            </Button>
            {menuOpen && exporting === "" && (
              <div
                role="menu"
                className="absolute right-0 z-10 mt-1 grid gap-1 rounded-lg border bg-white p-1 shadow"
              >
                <Button variant="ghost" onPress={() => runExport("jsonl")}>
                  {translate("导出为 JSONL")}
                </Button>
                <Button variant="ghost" onPress={() => runExport("csv")}>
                  {translate("导出为 CSV")}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
      <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">
        {translate("导出文件已脱敏，不含密钥与私有正文。")}
      </p>
      {exportNote && (
        <p role="status" className="text-sm text-emerald-700">
          {exportNote}
        </p>
      )}
      {exportError !== undefined && (
        <div className="grid gap-2">
          <Message error={exportError} />
          <Button
            variant="outline"
            className="justify-self-start"
            onPress={() => runExport(exporting || "jsonl")}
          >
            {translate("重试")}
          </Button>
        </div>
      )}
      {error !== undefined && <Message error={error} />}
      {loaded && rows.length === 0 && error === undefined ? (
        <Empty title={translate("没有符合条件的记录")}>
          <Button variant="outline" onPress={clear}>
            {translate("清除筛选")}
          </Button>
        </Empty>
      ) : (
        <Card className="panel table-wrap">
          <Table>
            <Table.ScrollContainer>
              <Table.Content aria-label={translate("审计记录")}>
                <Table.Header>
                  <Table.Column isRowHeader>{translate("时间")}</Table.Column>
                  <Table.Column>{translate("操作")}</Table.Column>
                  <Table.Column>{translate("人类责任主体")}</Table.Column>
                  <Table.Column>{translate("结果")}</Table.Column>
                  <Table.Column>{translate("操作")}</Table.Column>
                </Table.Header>
                <Table.Body>
                  {rows.map((r) => (
                    <Table.Row key={r.id} id={r.id}>
                      <Table.Cell className="whitespace-nowrap">
                        {stamp(r.occurred_at)}
                      </Table.Cell>
                      <Table.Cell>
                        <strong>{r.action}</strong>
                        <small>{short(r.resource_id)}</small>
                      </Table.Cell>
                      <Table.Cell>
                        {r.accountable_user_id}
                        <small>{r.actor?.kind}</small>
                      </Table.Cell>
                      <Table.Cell>
                        <Badge value={r.result} />
                      </Table.Cell>
                      <Table.Cell>
                        <Button
                          variant="ghost"
                          className="shrink-0 text-sm"
                          onClick={() => setSelected(r)}
                        >
                          {translate("追踪 →")}
                        </Button>
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>
          </Table>
        </Card>
      )}
      {rows.length > 0 &&
        (cursor ? (
          <Button
            variant="outline"
            className="justify-self-center"
            isDisabled={loading}
            onPress={() => load(applied, cursor)}
          >
            {translate("加载更多")}
          </Button>
        ) : (
          <p className="text-center text-sm text-slate-500">
            {translate("已全部加载")}
          </p>
        ))}
      {selected && (
        <Modal
          title={translate("审计责任链")}
          close={() => setSelected(undefined)}
        >
          <dl className="facts">
            <dt>{translate("实际操作者")}</dt>
            <dd>
              {selected.actor?.user_id ||
                selected.actor?.agent_id ||
                selected.actor?.service_id}
            </dd>
            <dt>{translate("人类责任主体")}</dt>
            <dd>{selected.accountable_user_id}</dd>
            <dt>Task Owner</dt>
            <dd>{selected.owner_user_id || "—"}</dd>
            <dt>{translate("执行 Run")}</dt>
            <dd>{selected.task_run_id || "—"}</dd>
            <dt>{translate("Context 快照")}</dt>
            <dd>{selected.context_snapshot_id || "—"}</dd>
            <dt>{translate("请求关联")}</dt>
            <dd>{selected.trace_id}</dd>
          </dl>
          <Json data={selected} />
        </Modal>
      )}
    </div>
  );
}
