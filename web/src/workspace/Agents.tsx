import { useI18n } from "../i18n";
import { Icon } from "../icons";
import { Card } from "@heroui/react";
import { useEffect, useState } from "react";
import type { Workspace } from "../main";
import type { Doc } from "../api";
import { short } from "../api";
import {
  Button,
  Input,
  Select,
  Checkbox,
  Action,
  Badge,
  Empty,
  Field,
  Form,
  Message,
  Modal,
  text,
} from "../ui";

export function Agents({ w }: { w: Workspace }) {
  const { translate, stamp } = useI18n();

  const [agents, setAgents] = useState<Doc[]>([]);
  const [sessions, setSessions] = useState<Doc[]>([]);
  const [creating, setCreating] = useState(false);
  const [granting, setGranting] = useState<Doc>();
  const [grant, setGrant] = useState<Doc>();
  const [error, setError] = useState<unknown>();
  async function load() {
    const [a, s] = await Promise.all([
      w.api.all(`/projects/${w.project.id}/agents`),
      w.api.all(`/projects/${w.project.id}/agent-sessions`),
    ]);
    setAgents(a);
    setSessions(s);
  }
  useEffect(() => {
    load().catch(setError);
  }, [w.api, w.project.id]);
  return (
    <>
      {error !== undefined && <Message error={error} />}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4 [&>p]:text-sm [&>p]:text-slate-600">
        <p className="text-sm leading-6 text-slate-600">
          {translate("注册客户端，为执行代理委托有限的权限。")}
        </p>
        <Button variant="primary" onClick={() => setCreating(true)}>
          {translate("＋ 注册执行代理")}
        </Button>
      </div>
      {!agents.length ? (
        <Empty title={translate("连接你的执行客户端")}>
          {translate("注册客户端信息，再创建短期 Session 授权。")}
        </Empty>
      ) : (
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2 2xl:grid-cols-3">
          {agents.map((a) => (
            <Card className="context-card" key={a.id}>
              <div className="context-icon">
                <Icon name="agents" />
              </div>
              <h3>{a.client_name}</h3>
              <p>
                {a.client_version} · {a.adapter_id}
              </p>
              <small>{a.registered_by_user_id}</small>
              <footer>
                <span>{short(a.id)}</span>
                <Button
                  variant="ghost"
                  className="shrink-0 text-sm"
                  onClick={() => setGranting(a)}
                >
                  {translate("授权执行 →")}
                </Button>
              </footer>
            </Card>
          ))}
        </div>
      )}
      <Card className="panel mt-6">
        <div className="section-title">
          <h2>{translate("执行授权 Session")}</h2>
          <Button
            variant="ghost"
            className="shrink-0 text-sm"
            onClick={() => load().catch(setError)}
          >
            {translate("刷新")}
          </Button>
        </div>
        {!sessions.length ? (
          <p className="text-sm leading-6 text-slate-600">
            {translate("尚未创建执行授权。")}
          </p>
        ) : (
          sessions.map((s) => (
            <div className="record-row" key={s.id}>
              <span>
                {agents.find((a) => a.id === s.agent_id)?.client_name ||
                  s.agent_id}
                <small>
                  {translate("{user} · 到期 {time}", {
                    user: s.delegated_by_user_id,
                    time: stamp(s.expires_at),
                  })}
                </small>
              </span>
              <Badge value={s.status} />
              {s.status === "ACTIVE" &&
                (s.delegated_by_user_id === w.me.id ||
                  w.roles.includes("ADMIN")) && (
                  <Action
                    danger
                    run={async () => {
                      await w.api.call(
                        `/agent-sessions/${s.id}/revoke`,
                        {
                          reason:
                            "Human revoked this delegation from the console",
                        },
                        s.version,
                      );
                      await load();
                    }}
                  >
                    {translate("撤销授权")}
                  </Action>
                )}
            </div>
          ))
        )}
      </Card>
      {creating && (
        <Modal
          title={translate("注册执行代理")}
          close={() => setCreating(false)}
        >
          <Form
            submit={translate("注册代理")}
            onDone={() => setCreating(false)}
            action={async (data) => {
              await w.api.call("/agents", {
                project_id: w.project.id,
                manifest: {
                  adapter_id: "accp_bridge",
                  adapter_version: "0.2.0",
                  protocol_versions: ["0.2"],
                  client: {
                    name: text(data, "client"),
                    version: text(data, "version"),
                  },
                  capabilities: {
                    claim: true,
                    context_read: true,
                    artifact_report: true,
                    heartbeat: true,
                    cancel: "cooperative",
                    notifications: ["poll", "sse"],
                    auto_start: false,
                  },
                },
              });
              await load();
            }}
          >
            <Field label={translate("客户端名称")}>
              <Input
                name="client"
                required
                placeholder={translate("使用的 AI 客户端名称")}
              />
            </Field>
            <Field label={translate("客户端版本")}>
              <Input
                name="version"
                required
                placeholder={translate("填写实际安装版本")}
              />
            </Field>
            <p className="notice">
              {translate(
                "通过 ACCP Local Bridge 接入，注册信息本身不代表已经完成兼容性验证。",
              )}
            </p>
          </Form>
        </Modal>
      )}
      {granting && (
        <Modal
          title={translate("授权 {name} 执行", { name: granting.client_name })}
          close={() => setGranting(undefined)}
        >
          <Form
            submit={translate("创建短期授权")}
            action={async (data) => {
              const issued = await w.api.call("/agent-sessions", {
                project_id: w.project.id,
                agent_id: granting.id,
                scopes: data.getAll("scopes"),
                expires_at: new Date(
                  Date.now() + Number(text(data, "hours")) * 3600000,
                ).toISOString(),
              });
              setGrant(issued);
              setGranting(undefined);
              await load();
            }}
          >
            <Field label={translate("授权时长")}>
              <Select name="hours">
                <option value="1">{translate("1 小时")}</option>
                <option value="4">{translate("4 小时")}</option>
                <option value="8">{translate("8 小时")}</option>
              </Select>
            </Field>
            <fieldset>
              <legend>{translate("权限范围")}</legend>
              {[
                { value: "tasks:read", name: translate("读取任务与执行记录") },
                {
                  value: "context:read",
                  name: translate("读取上下文和执行快照"),
                },
                { value: "runs:claim", name: translate("领取已分配任务") },
                { value: "runs:write", name: translate("心跳与执行报告") },
                { value: "artifacts:write", name: translate("上传执行成果") },
                { value: "events:read", name: translate("订阅项目事件") },
                {
                  value: "tools:invoke",
                  name: translate("通过网关请求工具操作"),
                },
              ].map((s) => (
                <Checkbox
                  key={s.value}
                  name="scopes"
                  value={s.value}
                  defaultSelected={s.value !== "tools:invoke"}
                >
                  {s.name}
                </Checkbox>
              ))}
            </fieldset>
            <p className="text-sm leading-6 text-slate-600">
              {translate("委托人：{name}。高风险操作仍需独立人类审批。", {
                name: w.me.display_name || w.me.id,
              })}
            </p>
          </Form>
        </Modal>
      )}
      {grant && (
        <Modal
          title={translate("执行授权已创建")}
          close={() => setGrant(undefined)}
        >
          <div className="notice">
            {translate(
              "凭证仅显示在当前窗口，请妥善交给本地 Bridge；关闭后可撤销并重新授权。",
            )}
          </div>
          <Field label="Session ID">
            <Input readOnly value={grant.session.id} />
          </Field>
          <Field label={translate("访问凭证")}>
            <Input type="password" readOnly value={grant.access_token} />
          </Field>
          <Action run={() => navigator.clipboard.writeText(grant.access_token)}>
            {translate("复制凭证")}
          </Action>
          <p>
            {translate(
              "本地 Bridge 使用 ACCP_URL 与 ACCP_SESSION_TOKEN 连接平台，并将 ACCP_ADAPTER_MANIFEST 指向与注册信息一致的 Adapter manifest JSON 文件。通过 accp-bridge stdio 供客户端使用。",
            )}
          </p>
          <small>
            {translate("有效期至 {time}", { time: stamp(grant.expires_at) })}
          </small>
        </Modal>
      )}
    </>
  );
}
