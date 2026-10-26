import { useI18n } from "../i18n";
import { Card, Table } from "@heroui/react";
import { useEffect, useState } from "react";
import type { Workspace } from "../main";
import type { Doc } from "../api";
import { short } from "../api";
import { Button, Input, Badge, Empty, Json, Message, Modal } from "../ui";
import { reviewer } from "./reviewer";

export function Audit({ w }: { w: Workspace }) {
  const { translate, stamp } = useI18n();

  const [rows, setRows] = useState<Doc[]>([]);
  const [error, setError] = useState<unknown>();
  const [selected, setSelected] = useState<Doc>();
  const [search, setSearch] = useState("");
  useEffect(() => {
    if (reviewer(w))
      w.api
        .all(`/projects/${w.project.id}/audit-records`)
        .then((a) =>
          setRows(
            a.sort((a, b) =>
              String(b.occurred_at).localeCompare(String(a.occurred_at)),
            ),
          ),
        )
        .catch(setError);
  }, [w.api, w.project.id]);
  if (!reviewer(w))
    return (
      <Empty title={translate("审计记录需要审核权限")}>
        {translate("请联系项目管理员授予相应角色。")}
      </Empty>
    );
  return (
    <>
      {error !== undefined && <Message error={error} />}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4 [&>p]:text-sm [&>p]:text-slate-600">
        <p className="text-sm leading-6 text-slate-600">
          {translate("查看操作者、责任人、执行依据和审核结果。")}
        </p>
        <Input
          className="w-full sm:ml-auto sm:max-w-72"
          aria-label={translate("搜索审计记录")}
          placeholder={translate("搜索操作者、任务或操作…")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
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
                {rows
                  .filter((r) =>
                    JSON.stringify(r)
                      .toLowerCase()
                      .includes(search.toLowerCase()),
                  )
                  .map((r) => (
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
                        <small>{r.actor.kind}</small>
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
      {selected && (
        <Modal
          title={translate("审计责任链")}
          close={() => setSelected(undefined)}
        >
          <dl className="facts">
            <dt>{translate("实际操作者")}</dt>
            <dd>
              {selected.actor.user_id ||
                selected.actor.agent_id ||
                selected.actor.service_id}
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
    </>
  );
}
