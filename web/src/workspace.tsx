import { useI18n } from "./i18n";
import { Icon } from "./icons";
import { Card, Table, ToggleButton, ToggleButtonGroup } from "@heroui/react";
import { useEffect, useState } from "react";
import type { Workspace } from "./main";
import type { Doc, Membership } from "./api";
import { short } from "./api";
import {
  Button,
  Input,
  Select,
  TextArea,
  Checkbox,
  Action,
  Badge,
  Empty,
  Field,
  Form,
  Json,
  Message,
  Modal,
  text,
} from "./ui";

const reviewer = (w: Workspace) =>
  w.roles.includes("REVIEWER") || w.roles.includes("ADMIN");
export function Contexts({ w }: { w: Workspace }) {
  const { translate, label } = useI18n();

  const [selected, setSelected] = useState<Doc>();
  const [creating, setCreating] = useState(false);
  const [versions, setVersions] = useState<Doc[]>([]);
  const [body, setBody] = useState("");
  const [error, setError] = useState<unknown>();
  async function open(c: Doc) {
    setSelected(c);
    setBody("");
    try {
      setVersions(await w.api.all(`/contexts/${c.id}/versions`));
    } catch (e) {
      setError(e);
    }
  }
  async function save(data: FormData, context?: Doc) {
    const content = await w.api.call(`/projects/${w.project.id}/contents`, {
      content: String(data.get("content") || ""),
      media_type: "text/markdown",
    });
    const c = context
      ? await w.api.call(`/contexts/${context.id}`)
      : await w.api.call(`/projects/${w.project.id}/contexts`, {
          name: text(data, "name"),
          type: text(data, "type"),
          source: {
            kind: "ACCP",
            canonical_uri: `urn:accp:context:${crypto.randomUUID()}`,
          },
        });
    await w.api.call(
      `/contexts/${c.id}/versions`,
      {
        source_revision: text(data, "revision"),
        content_uri: content.content_uri,
        content_digest: content.content_digest,
        media_type: content.media_type,
        change_summary: text(data, "summary"),
      },
      c.version,
    );
    await w.refresh();
    if (context) await open(c);
  }
  const fields = (
    <>
      <Field label={translate("来源版本")}>
        <Input name="revision" required placeholder={translate("例如：1.0")} />
      </Field>
      <Field label={translate("变更说明")}>
        <Input
          name="summary"
          required
          placeholder={translate("说明本次版本的变化")}
        />
      </Field>
      <Field label={translate("正文（Markdown）")}>
        <TextArea
          name="content"
          required
          rows={9}
          placeholder={translate("写入需求、接口契约或项目规范…")}
        />
      </Field>
    </>
  );
  return (
    <>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4 [&>p]:text-sm [&>p]:text-slate-600">
        <p className="text-sm leading-6 text-slate-600">
          {translate("发布明确版本，作为任务执行的共同依据。")}
        </p>
        <Button variant="primary" onClick={() => setCreating(true)}>
          {translate("＋ 新建上下文")}
        </Button>
      </div>
      {error !== undefined && <Message error={error} />}{" "}
      {!w.contexts.length ? (
        <Empty title={translate("建立团队的共同依据")}>
          {translate("从需求、API、数据库结构或项目规范开始。")}
        </Empty>
      ) : (
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2 2xl:grid-cols-3">
          {w.contexts.map((c) => (
            <Button
              variant="secondary"
              className="context-card"
              key={c.id}
              onClick={() => open(c)}
            >
              <div className="context-icon">
                <Icon name="contexts" />
              </div>
              <span className="text-xs font-medium tracking-wide text-slate-600">
                {label(c.type)}
              </span>
              <h3>{c.name}</h3>
              <p>
                {c.current_published_version_id
                  ? translate("已发布权威版本")
                  : translate("等待发布候选版本")}
              </p>
              <footer>
                <span>
                  {translate("来源：{source}", { source: c.source.kind })}
                </span>
                <span>v{c.version} ↗</span>
              </footer>
            </Button>
          ))}
        </div>
      )}
      {creating && (
        <Modal
          title={translate("新建共享上下文")}
          close={() => setCreating(false)}
        >
          <Form
            submit={translate("创建候选版本")}
            onDone={() => setCreating(false)}
            action={(data) => save(data)}
          >
            <Field label={translate("名称")}>
              <Input
                name="name"
                required
                placeholder={translate("例如：订单查询 API")}
              />
            </Field>
            <Field label={translate("类型")}>
              <Select name="type">
                {[
                  "REQUIREMENT",
                  "API",
                  "DB_SCHEMA",
                  "ADR",
                  "PROJECT_STANDARD",
                ].map((t) => (
                  <option value={t} key={t}>
                    {t === "PROJECT_STANDARD"
                      ? translate("项目规范")
                      : label(t)}
                  </option>
                ))}
              </Select>
            </Field>
            {fields}
          </Form>
        </Modal>
      )}
      {selected && (
        <Modal title={selected.name} close={() => setSelected(undefined)}>
          <p className="text-sm leading-6 text-slate-600">
            {translate("权威来源：{source} · 历史正文与版本保持不变。", {
              source: selected.source.kind,
            })}
          </p>
          {versions.map((v) => (
            <div className="record-row" key={v.id}>
              <span>
                <strong>{v.source_revision}</strong>
                <small>{v.change_summary}</small>
              </span>
              <Badge value={v.status} />
              <Action
                run={async () => {
                  const content = await w.api.call(
                    `/contents/${String(v.content_uri).split(":").at(-1)}`,
                  );
                  setBody(content.content);
                }}
              >
                {translate("查看正文")}
              </Action>
              {v.status === "CANDIDATE" && reviewer(w) && (
                <Action
                  run={async () => {
                    await w.api.call(
                      `/contexts/${selected.id}/versions/${v.id}/publish`,
                      {},
                      v.version,
                    );
                    await w.refresh();
                    await open(selected);
                  }}
                >
                  {translate("发布版本")}
                </Action>
              )}
            </div>
          ))}
          {body && (
            <pre className="my-4 max-h-96 overflow-auto rounded-lg border border-slate-200 bg-slate-50 p-5 text-sm leading-7 whitespace-pre-wrap break-words">
              {body}
            </pre>
          )}
          <details>
            <summary>{translate("新增候选版本")}</summary>
            <Form
              submit={translate("保存新版本")}
              action={(data) => save(data, selected)}
            >
              {fields}
            </Form>
          </details>
        </Modal>
      )}
    </>
  );
}
export function Artifacts({ w }: { w: Workspace }) {
  const { translate, label, stamp } = useI18n();

  const [selected, setSelected] = useState<Doc>();
  const [content, setContent] = useState("");
  const [history, setHistory] = useState<Doc[]>([]);
  const [error, setError] = useState<unknown>();
  async function open(a: Doc) {
    try {
      const current = await w.api.call(`/artifacts/${a.id}`);
      setSelected(current);
      setContent("");
      const [reviews, checks] = await Promise.all([
        w.api.all(`/artifacts/${a.id}/reviews`),
        w.api.all(`/artifacts/${a.id}/verifications`),
      ]);
      setHistory([...reviews, ...checks]);
      if (current.uri.startsWith("urn:accp:artifact-content:")) {
        const text = await w.api.call(
          `/artifact-contents/${current.uri.split(":").at(-1)}`,
        );
        setContent(text.content);
      }
    } catch (e) {
      setError(e);
    }
  }
  return (
    <>
      {error !== undefined && <Message error={error} />}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4 [&>p]:text-sm [&>p]:text-slate-600">
        <p className="text-sm leading-6 text-slate-600">
          {translate("核验内容与来源，再由人类接受成果。")}
        </p>
        <span className="text-sm text-slate-600">
          {translate("{count} 份成果", { count: w.artifacts.length })}
        </span>
      </div>
      {!w.artifacts.length ? (
        <Empty title={translate("尚无交付成果")}>
          {translate("Agent 执行任务后，成果会连同来源与核验状态显示在这里。")}
        </Empty>
      ) : (
        <Card className="panel table-wrap">
          <Table>
            <Table.ScrollContainer>
              <Table.Content aria-label={translate("交付成果")}>
                <Table.Header>
                  <Table.Column isRowHeader>{translate("成果")}</Table.Column>
                  <Table.Column>{translate("所属任务")}</Table.Column>
                  <Table.Column>{translate("核验")}</Table.Column>
                  <Table.Column>{translate("人工接受")}</Table.Column>
                  <Table.Column>{translate("负责人")}</Table.Column>
                  <Table.Column>{translate("操作")}</Table.Column>
                </Table.Header>
                <Table.Body>
                  {w.artifacts.map((a) => (
                    <Table.Row key={a.id} id={a.id}>
                      <Table.Cell>
                        <strong>{label(a.kind)}</strong>
                        <small>{short(a.id)}</small>
                      </Table.Cell>
                      <Table.Cell>
                        {w.tasks.find((t) => t.id === a.provenance.task_id)
                          ?.title || short(a.provenance.task_id)}
                      </Table.Cell>
                      <Table.Cell>
                        <Badge value={a.verification_status} />
                      </Table.Cell>
                      <Table.Cell>
                        <Badge value={a.acceptance_status} />
                      </Table.Cell>
                      <Table.Cell>{a.provenance.owner_user_id}</Table.Cell>
                      <Table.Cell>
                        <Button
                          variant="ghost"
                          className="shrink-0 text-sm"
                          onClick={() => open(a)}
                        >
                          {translate("查看 →")}
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
      {selected && (
        <Modal
          title={translate("{kind} · 成果详情", { kind: label(selected.kind) })}
          close={() => setSelected(undefined)}
        >
          <div className="mb-5 flex flex-wrap items-center gap-3 text-sm text-slate-600">
            <Badge value={selected.verification_status} />
            <Badge value={selected.acceptance_status} />
            <span>
              {translate("版本 {version}", { version: selected.version })}
            </span>
          </div>
          <dl className="facts">
            <dt>{translate("内容摘要")}</dt>
            <dd className="font-mono text-xs break-all">
              {selected.content_digest}
            </dd>
            <dt>{translate("不可变版本")}</dt>
            <dd className="font-mono text-xs break-all">
              {selected.immutable_revision || translate("已存储的正文摘要")}
            </dd>
            <dt>{translate("成果引用")}</dt>
            <dd>
              {/^https:\/\//.test(selected.uri) ? (
                <a href={selected.uri} target="_blank" rel="noreferrer">
                  {selected.uri} ↗
                </a>
              ) : (
                selected.uri
              )}
            </dd>
          </dl>
          {content && (
            <pre className="my-4 max-h-96 overflow-auto rounded-lg border border-slate-200 bg-slate-50 p-5 text-sm leading-7 whitespace-pre-wrap break-words">
              {content}
            </pre>
          )}
          {reviewer(w) && selected.acceptance_status === "PENDING" && (
            <div className="mt-6 rounded-xl border border-slate-200 bg-slate-50 p-5">
              {["COMMIT", "PULL_REQUEST", "CODE_DIFF"].includes(
                selected.kind,
              ) && (
                <Action
                  run={async () => {
                    await w.api.call(
                      `/artifacts/${selected.id}/verifications`,
                      { reason: "Human requested Git provider verification" },
                      selected.version,
                    );
                    await w.refresh();
                    await open(selected);
                  }}
                >
                  {translate("从 Git 服务核验当前版本")}
                </Action>
              )}
              <Form
                submit={translate("提交成果审核")}
                action={async (data) => {
                  await w.api.call(
                    `/artifacts/${selected.id}/reviews`,
                    {
                      decision: text(data, "decision"),
                      content_digest: selected.content_digest,
                      reason: text(data, "reason"),
                    },
                    selected.version,
                  );
                  await w.refresh();
                  await open(selected);
                }}
              >
                <Field label={translate("决定")}>
                  <Select name="decision">
                    <option value="ACCEPT">{translate("接受成果")}</option>
                    <option value="REJECT">{translate("拒绝成果")}</option>
                  </Select>
                </Field>
                <Field label={translate("审核依据")}>
                  <TextArea
                    name="reason"
                    required
                    placeholder={translate("说明已核对的内容与证据")}
                  />
                </Field>
              </Form>
            </div>
          )}
          <h3>{translate("来源追踪")}</h3>
          <Json data={selected.provenance} />
          <h3>{translate("核验与人工审核记录")}</h3>
          {history.length ? (
            history.map((r) => (
              <div className="timeline-item" key={r.id}>
                <strong>
                  {r.decision || r.status} ·{" "}
                  {r.reviewed_by_user_id || r.verified_by_user_id}
                </strong>
                <small>{stamp(r.created_at)}</small>
                <p>
                  {r.reason || r.error_code || translate("Git 服务核验通过")}
                </p>
              </div>
            ))
          ) : (
            <p className="text-sm leading-6 text-slate-600">
              {translate("暂无外部核验或人工审核记录。")}
            </p>
          )}
        </Modal>
      )}
    </>
  );
}
export function Approvals({ w }: { w: Workspace }) {
  const { translate, label, stamp } = useI18n();

  const [selected, setSelected] = useState<Doc>();
  const [invocation, setInvocation] = useState<Doc>();
  const [filter, setFilter] = useState("PENDING");
  const [error, setError] = useState<unknown>();
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
          <Card className="approval-card" key={a.id}>
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
export function Members({ w }: { w: Workspace }) {
  const { translate, label } = useI18n();

  const [selected, setSelected] = useState<Membership>();
  return (
    <>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4 [&>p]:text-sm [&>p]:text-slate-600">
        <p className="text-sm leading-6 text-slate-600">
          {translate("企业身份与项目角色共同决定访问权限。")}
        </p>
      </div>
      <Card className="panel table-wrap">
        <Table>
          <Table.ScrollContainer>
            <Table.Content aria-label={translate("项目成员")}>
              <Table.Header>
                <Table.Column isRowHeader>{translate("成员")}</Table.Column>
                <Table.Column>{translate("项目角色")}</Table.Column>
                <Table.Column>{translate("状态")}</Table.Column>
                <Table.Column>{translate("操作")}</Table.Column>
              </Table.Header>
              <Table.Body>
                {w.members.map((m) => (
                  <Table.Row key={m.id} id={m.id}>
                    <Table.Cell>
                      <strong>{m.display_name || m.id}</strong>
                      <small>{m.id}</small>
                    </Table.Cell>
                    <Table.Cell>{m.roles.map(label).join(" / ")}</Table.Cell>
                    <Table.Cell>
                      <Badge value={m.active ? "ACTIVE" : "REVOKED"} />
                    </Table.Cell>
                    <Table.Cell>
                      {w.roles.includes("ADMIN") && (
                        <Button
                          variant="ghost"
                          className="shrink-0 text-sm"
                          onClick={() => setSelected(m)}
                        >
                          {translate("管理角色")}
                        </Button>
                      )}
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
          title={translate("管理 {name}", {
            name: selected.display_name || selected.id,
          })}
          close={() => setSelected(undefined)}
        >
          <Form
            submit={translate("保存成员权限")}
            onDone={() => setSelected(undefined)}
            action={async (data) => {
              await w.api.call(
                `/projects/${w.project.id}/members/${selected.id}/changes`,
                {
                  roles: data.getAll("roles"),
                  active: data.has("active"),
                  reason: text(data, "reason"),
                },
                selected.version,
              );
              await w.refresh();
            }}
          >
            <fieldset>
              <legend>{translate("角色")}</legend>
              {["ADMIN", "MEMBER", "REVIEWER", "VIEWER"].map((role) => (
                <Checkbox
                  key={role}
                  name="roles"
                  value={role}
                  defaultSelected={selected.roles.includes(role)}
                >
                  {label(role)}
                </Checkbox>
              ))}
            </fieldset>
            <Checkbox name="active" defaultSelected={selected.active}>
              {translate("启用成员访问")}
            </Checkbox>
            <Field label={translate("变更原因")}>
              <TextArea name="reason" required />
            </Field>
          </Form>
        </Modal>
      )}
    </>
  );
}
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
export function Tools({ w }: { w: Workspace }) {
  const { translate, label, stamp } = useI18n();

  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<Doc>();
  const [backends, setBackends] = useState<Doc[]>([]);
  const [invocations, setInvocations] = useState<Doc[]>([]);
  const [error, setError] = useState<unknown>();
  async function load() {
    if (w.roles.includes("ADMIN"))
      setBackends(
        (await w.api.call(`/projects/${w.project.id}/tool-backends`)).items,
      );
    if (reviewer(w))
      setInvocations(
        await w.api.all(`/projects/${w.project.id}/tool-invocations`),
      );
  }
  useEffect(() => {
    load().catch(setError);
  }, [w.api, w.project.id]);
  const fields = (
    <>
      <Field label={translate("已配置工具")}>
        <Select
          name="backend"
          defaultValue={selected?.backend_id}
          required
          disabled={!!selected}
        >
          {backends.map((b) => (
            <option key={b.id} value={b.id}>
              {b.id} · {label(b.risk)}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={translate("工具名称")}>
        <Input name="name" required defaultValue={selected?.name} />
      </Field>
      <Field
        label={translate("资源版本")}
        hint={translate("版本变化后，旧审批不能用于执行。")}
      >
        <Input
          name="revision"
          required
          defaultValue={selected?.resource_version || "1"}
        />
      </Field>
      <Checkbox
        name="enabled"
        defaultSelected={selected ? selected.enabled : true}
      >
        {translate("允许请求此工具")}
      </Checkbox>
      <Field label={translate("配置原因")}>
        <TextArea name="reason" required />
      </Field>
    </>
  );
  return (
    <>
      {error !== undefined && <Message error={error} />}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4 [&>p]:text-sm [&>p]:text-slate-600">
        <p className="text-sm leading-6 text-slate-600">
          {translate("工具风险由受信配置决定，调用经过权限检查与审批。")}
        </p>
        {w.roles.includes("ADMIN") && (
          <Button
            variant="primary"
            onClick={() => {
              setSelected(undefined);
              setCreating(true);
            }}
          >
            {translate("＋ 注册工具策略")}
          </Button>
        )}
      </div>
      {!w.tools.length ? (
        <Empty title={translate("尚未开放工具")}>
          {translate("管理员先配置下游工具端点与凭证，再为项目注册策略。")}
        </Empty>
      ) : (
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2 2xl:grid-cols-3">
          {w.tools.map((t) => (
            <Card className="context-card" key={t.id}>
              <div className="context-icon">
                <Icon name="tools" />
              </div>
              <h3>{t.name}</h3>
              <Badge value={t.risk} />
              <p>
                {t.resource_id} · {t.resource_version}
              </p>
              <footer>
                <span>
                  {t.enabled ? translate("已开放") : translate("已停用")}
                </span>
                {w.roles.includes("ADMIN") && (
                  <Button
                    variant="ghost"
                    className="shrink-0 text-sm"
                    onClick={() => {
                      setSelected(t);
                      setCreating(true);
                    }}
                  >
                    {translate("管理策略")}
                  </Button>
                )}
              </footer>
            </Card>
          ))}
        </div>
      )}
      <Card className="panel mt-6">
        <div className="section-title">
          <h2>{translate("工具操作记录")}</h2>
          <Button
            variant="ghost"
            className="shrink-0 text-sm"
            onClick={() => load().catch(setError)}
          >
            {translate("刷新")}
          </Button>
        </div>
        {invocations.length ? (
          invocations.map((i) => (
            <div className="record-row" key={i.id}>
              <span>
                {w.tools.find((t) => t.id === i.binding.tool_id)?.name ||
                  i.binding.tool_id}
                <small>
                  {short(i.id)} · {stamp(i.created_at)}
                </small>
              </span>
              <Badge value={i.status} />
              {i.status === "UNKNOWN" && w.roles.includes("ADMIN") && (
                <Action
                  run={async () => {
                    await w.api.call(
                      `/tool-invocations/${i.id}/reconcile`,
                      {
                        reason:
                          "Administrator queried the external operation result",
                      },
                      i.version,
                    );
                    await load();
                  }}
                >
                  {translate("查询外部结果")}
                </Action>
              )}
            </div>
          ))
        ) : (
          <p className="text-sm leading-6 text-slate-600">
            {translate("暂无可查看的操作记录。")}
          </p>
        )}
      </Card>
      {creating && (
        <Modal
          title={
            selected ? translate("更新工具策略") : translate("注册工具策略")
          }
          close={() => setCreating(false)}
        >
          {!backends.length ? (
            <div className="notice">
              {translate(
                "当前没有配置下游工具。请由部署管理员配置工具目录后重启 API 与 Worker。",
              )}
            </div>
          ) : (
            <Form
              submit={translate("保存工具策略")}
              onDone={() => setCreating(false)}
              action={async (data) => {
                const body = {
                  backend_id: selected?.backend_id || text(data, "backend"),
                  name: text(data, "name"),
                  resource_version: text(data, "revision"),
                  enabled: data.has("enabled"),
                  reason: text(data, "reason"),
                };
                if (selected)
                  await w.api.call(
                    `/tools/${selected.id}/changes`,
                    body,
                    selected.version,
                  );
                else await w.api.call(`/projects/${w.project.id}/tools`, body);
                await w.refresh();
              }}
            >
              {fields}
            </Form>
          )}
        </Modal>
      )}
    </>
  );
}
