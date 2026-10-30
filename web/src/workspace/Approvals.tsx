import { useI18n } from "../i18n";
import { Icon } from "../icons";
import { Card, ToggleButton, ToggleButtonGroup } from "@heroui/react";
import { useEffect, useRef, useState } from "react";
import type { Workspace } from "../main";
import type { Doc } from "../api";
import { readApprovalFocus } from "../routing";
import {
  Button,
  Select,
  TextArea,
  Action,
  Badge,
  Empty,
  Field,
  Form,
  Json,
  Message,
  Modal,
  text,
} from "../ui";
import { reviewer } from "./reviewer";

export function Approvals({ w }: { w: Workspace }) {
  const { translate, label, stamp } = useI18n();

  const [selected, setSelected] = useState<Doc>();
  const [invocation, setInvocation] = useState<Doc>();
  const [filter, setFilter] = useState("PENDING");
  const [error, setError] = useState<unknown>();
  const [focusID, setFocusID] = useState("");
  const consumed = useRef("");

  // O-W11: consume `?approval=:id` deep link — open the target approval's Modal
  // and (below) scroll its card into view. Runs once the row is loaded so a
  // transient empty `w.approvals` doesn't drop the link.
  useEffect(() => {
    if (!reviewer(w)) return;
    const id = readApprovalFocus(location.search);
    if (!id || consumed.current === id) return;
    const target = w.approvals.find((a) => a.id === id);
    if (!target) return;
    consumed.current = id;
    history.replaceState(history.state, "", location.pathname + location.hash);
    if (target.status !== "PENDING") setFilter("all");
    setFocusID(id);
    void open(target);
  }, [w.approvals]);

  // Scroll the focused card into view once it renders (filter may need to flip
  // to "all" first). Clears focus so later filter changes don't re-scroll.
  useEffect(() => {
    if (!focusID) return;
    const el = document.querySelector(
      `[data-approval-id="${CSS.escape(focusID)}"]`,
    );
    if (el) {
      el.scrollIntoView({ block: "center" });
      setFocusID("");
    }
  }, [focusID, filter, w.approvals]);

  if (!reviewer(w))
    return (
      <Empty title={translate("审批由审核人处理")}>
        {translate(
          "当前角色可以执行授权任务；高风险操作需要独立的人类审核人。",
        )}
      </Empty>
    );
  async function open(a: Doc) {
    try {
      setSelected(await w.api.call(`/approvals/${a.id}`));
      setInvocation(await w.api.call(`/tool-invocations/${a.invocation_id}`));
    } catch (e) {
      setError(e);
    }
  }
  const rows = w.approvals.filter(
    (a) => filter === "all" || a.status === filter,
  );
  return (
    <>
      {error !== undefined && <Message error={error} />}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4 [&>p]:text-sm [&>p]:text-slate-600">
        <ToggleButtonGroup
          aria-label={translate("筛选审批")}
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={[filter]}
          onSelectionChange={(keys) => setFilter(String([...keys][0]))}
        >
          <ToggleButton id="PENDING">{translate("待我审核")}</ToggleButton>
          <ToggleButton id="all">{translate("全部记录")}</ToggleButton>
        </ToggleButtonGroup>
        <p className="text-sm leading-6 text-slate-600">
          {translate("审批只授权当前参数、资源和版本。")}
        </p>
      </div>
      {!rows.length ? (
        <Empty title={translate("当前没有待处理的审批")}>
          {translate("需要人工批准的工具操作会自动进入这里。")}
        </Empty>
      ) : (
        rows.map((a) => (
          <Card className="approval-card" key={a.id} data-approval-id={a.id}>
            <div className="approval-icon">
              <Icon name="approvals" />
            </div>
            <div>
              <h3>
                {w.tools.find((t) => t.id === a.binding.tool_id)?.name ||
                  a.binding.tool_id}
              </h3>
              <p>
                {translate("请求人：{requester} · 目标：{resource}", {
                  requester: a.requester_user_id,
                  resource: a.binding.resource_id,
                })}
              </p>
              <small>
                {translate("有效期至 {time}", {
                  time: stamp(a.binding.expires_at),
                })}
              </small>
            </div>
            <Badge value={a.status} />
            <Button variant="secondary" onClick={() => open(a)}>
              {translate("检查操作 →")}
            </Button>
          </Card>
        ))
      )}
      {selected && (
        <Modal
          title={translate("检查并审批操作")}
          close={() => {
            setSelected(undefined);
            setInvocation(undefined);
          }}
        >
          <div className="notice">
            {translate(
              "核对目标资源、参数与成果。本次决定只能用于这一项操作。",
            )}
          </div>
          <dl className="facts">
            <dt>{translate("请求人")}</dt>
            <dd>{selected.requester_user_id}</dd>
            <dt>{translate("资源 / 版本")}</dt>
            <dd>
              {selected.binding.resource_id} /{" "}
              {selected.binding.resource_version}
            </dd>
            <dt>{translate("代码版本")}</dt>
            <dd className="font-mono text-xs break-all">
              {selected.binding.commit_sha ||
                translate("本操作未绑定 Git Commit")}
            </dd>
            <dt>{translate("策略 / 工具版本")}</dt>
            <dd>
              {selected.binding.policy_version} /{" "}
              {selected.binding.tool_schema_version}
            </dd>
            <dt>{translate("审批有效期")}</dt>
            <dd>{stamp(selected.binding.expires_at)}</dd>
            <dt>{translate("绑定摘要")}</dt>
            <dd className="font-mono text-xs break-all">
              {selected.binding_digest}
            </dd>
          </dl>
          <h3>{translate("本次操作参数")}</h3>
          {invocation ? (
            <Json data={invocation.parameters} />
          ) : (
            <p>{translate("正在读取…")}</p>
          )}
          <h3>{translate("关联成果")}</h3>
          {selected.binding.artifact_ids.length ? (
            selected.binding.artifact_ids.map((id: string) => {
              const artifact = w.artifacts.find((a) => a.id === id);
              return (
                <div className="record-row" key={id}>
                  <span>
                    {artifact ? label(artifact.kind) : id}
                    <small>{artifact?.content_digest}</small>
                  </span>
                  <Badge
                    value={artifact?.verification_status || "UNVERIFIED"}
                  />
                </div>
              );
            })
          ) : (
            <p className="text-sm leading-6 text-slate-600">
              {translate("本次请求没有关联成果。")}
            </p>
          )}
          {selected.status === "PENDING" &&
          selected.requester_user_id !== w.me.id ? (
            <Form
              submit={translate("提交审批决定")}
              action={async (data) => {
                await w.api.call(
                  `/approvals/${selected.id}/decisions`,
                  {
                    decision: text(data, "decision"),
                    binding_digest: selected.binding_digest,
                    reason: text(data, "reason"),
                  },
                  selected.version,
                );
                await w.refresh();
                await open(selected);
              }}
            >
              <Field label={translate("审批决定")}>
                <Select name="decision">
                  <option value="APPROVE">{translate("批准这一次操作")}</option>
                  <option value="REJECT">{translate("拒绝执行")}</option>
                </Select>
              </Field>
              <Field label={translate("审核意见")}>
                <TextArea name="reason" required />
              </Field>
            </Form>
          ) : (
            <div className="notice">
              {selected.requester_user_id === w.me.id &&
              selected.status === "PENDING"
                ? translate("你是本次请求的委托人，需要另一位审核人作出决定。")
                : `${label(selected.status)} · ${selected.decided_by_user_id || ""} ${selected.reason || ""}`}
            </div>
          )}
          {invocation && (
            <div className="record-row">
              <span>{translate("工具执行状态")}</span>
              <Badge value={invocation.status} />
              <Action run={() => open(selected)}>
                {translate("更新状态")}
              </Action>
            </div>
          )}
        </Modal>
      )}
    </>
  );
}
