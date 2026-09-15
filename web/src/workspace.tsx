import { useEffect, useState } from "react";
import type { Workspace } from "./main";
import type { Doc, Membership } from "./api";
import { label, short, stamp } from "./api";
import {
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
      <Field label="来源版本">
        <input name="revision" required placeholder="例如：1.0" />
      </Field>
      <Field label="变更说明">
        <input name="summary" required placeholder="说明本次版本的变化" />
      </Field>
      <Field label="正文（Markdown）">
        <textarea
          name="content"
          required
          rows={9}
          placeholder="写入需求、接口契约或项目规范…"
        />
      </Field>
    </>
  );
  return (
    <>
      <div className="toolbar">
        <p className="muted">发布明确版本，作为任务执行的共同依据。</p>
        <button className="primary" onClick={() => setCreating(true)}>
          ＋ 新建上下文
        </button>
      </div>
      {error !== undefined && <Message error={error} />}{" "}
      {!w.contexts.length ? (
        <Empty title="建立团队的共同依据">
          从需求、API、数据库结构或项目规范开始。
        </Empty>
      ) : (
        <div className="context-grid">
          {w.contexts.map((c) => (
            <button className="context-card" key={c.id} onClick={() => open(c)}>
              <div className="context-icon">▧</div>
              <span className="eyebrow">{label(c.type)}</span>
              <h3>{c.name}</h3>
              <p>
                {c.current_published_version_id
                  ? "已发布权威版本"
                  : "等待发布候选版本"}
              </p>
              <footer>
                <span>来源：{c.source.kind}</span>
                <span>v{c.version} ↗</span>
              </footer>
            </button>
          ))}
        </div>
      )}
      {creating && (
        <Modal title="新建共享上下文" close={() => setCreating(false)}>
          <Form
            submit="创建候选版本"
            onDone={() => setCreating(false)}
            action={(data) => save(data)}
          >
            <Field label="名称">
              <input name="name" required placeholder="例如：订单查询 API" />
            </Field>
            <Field label="类型">
              <select name="type">
                {[
                  "REQUIREMENT",
                  "API",
                  "DB_SCHEMA",
                  "ADR",
                  "PROJECT_STANDARD",
                ].map((t) => (
                  <option value={t} key={t}>
                    {t === "PROJECT_STANDARD" ? "项目规范" : label(t)}
                  </option>
                ))}
              </select>
            </Field>
            {fields}
          </Form>
        </Modal>
      )}
      {selected && (
        <Modal title={selected.name} close={() => setSelected(undefined)}>
          <p className="muted">
            权威来源：{selected.source.kind} · 历史正文与版本保持不变。
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
                查看正文
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
                  发布版本
                </Action>
              )}
            </div>
          ))}
          {body && <pre className="content-preview">{body}</pre>}
          <details>
            <summary>新增候选版本</summary>
            <Form submit="保存新版本" action={(data) => save(data, selected)}>
              {fields}
            </Form>
          </details>
        </Modal>
      )}
    </>
  );
}
export function Artifacts({ w }: { w: Workspace }) {
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
      <div className="toolbar">
        <p className="muted">核验内容与来源，再由人类接受成果。</p>
        <span className="count-label">{w.artifacts.length} 份成果</span>
      </div>
      {!w.artifacts.length ? (
        <Empty title="尚无交付成果">
          Agent 执行任务后，成果会连同来源与核验状态显示在这里。
        </Empty>
      ) : (
        <section className="panel table-wrap">
          <table>
            <thead>
              <tr>
                <th>成果</th>
                <th>所属任务</th>
                <th>核验</th>
                <th>人工接受</th>
                <th>负责人</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {w.artifacts.map((a) => (
                <tr key={a.id}>
                  <td>
                    <strong>{label(a.kind)}</strong>
                    <small>{short(a.id)}</small>
                  </td>
                  <td>
                    {w.tasks.find((t) => t.id === a.provenance.task_id)
                      ?.title || short(a.provenance.task_id)}
                  </td>
                  <td>
                    <Badge value={a.verification_status} />
                  </td>
                  <td>
                    <Badge value={a.acceptance_status} />
                  </td>
                  <td>{a.provenance.owner_user_id}</td>
                  <td>
                    <button className="text-button" onClick={() => open(a)}>
                      查看 →
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {selected && (
        <Modal
          title={`${label(selected.kind)} · 成果详情`}
          close={() => setSelected(undefined)}
        >
          <div className="detail-meta">
            <Badge value={selected.verification_status} />
            <Badge value={selected.acceptance_status} />
            <span>版本 {selected.version}</span>
          </div>
          <dl className="facts">
            <dt>内容摘要</dt>
            <dd className="mono">{selected.content_digest}</dd>
            <dt>不可变版本</dt>
            <dd className="mono">
              {selected.immutable_revision || "已存储的正文摘要"}
            </dd>
            <dt>成果引用</dt>
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
          {content && <pre className="content-preview">{content}</pre>}
          {reviewer(w) && selected.acceptance_status === "PENDING" && (
            <div className="review-box">
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
                  从 Git 服务核验当前版本
                </Action>
              )}
              <Form
                submit="提交成果审核"
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
                <Field label="决定">
                  <select name="decision">
                    <option value="ACCEPT">接受成果</option>
                    <option value="REJECT">拒绝成果</option>
                  </select>
                </Field>
                <Field label="审核依据">
                  <textarea
                    name="reason"
                    required
                    placeholder="说明已核对的内容与证据"
                  />
                </Field>
              </Form>
            </div>
          )}
          <h3>来源追踪</h3>
          <Json data={selected.provenance} />
          <h3>核验与人工审核记录</h3>
          {history.length ? (
            history.map((r) => (
              <div className="timeline-item" key={r.id}>
                <strong>
                  {r.decision || r.status} ·{" "}
                  {r.reviewed_by_user_id || r.verified_by_user_id}
                </strong>
                <small>{stamp(r.created_at)}</small>
                <p>{r.reason || r.error_code || "Git 服务核验通过"}</p>
              </div>
            ))
          ) : (
            <p className="muted">暂无外部核验或人工审核记录。</p>
          )}
        </Modal>
      )}
    </>
  );
}
export function Approvals({ w }: { w: Workspace }) {
  const [selected, setSelected] = useState<Doc>();
  const [invocation, setInvocation] = useState<Doc>();
  const [filter, setFilter] = useState("PENDING");
  const [error, setError] = useState<unknown>();
  if (!reviewer(w))
    return (
      <Empty title="审批由审核人处理">
        当前角色可以执行授权任务；高风险操作需要独立的人类审核人。
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
      <div className="toolbar">
        <div className="segmented">
          <button
            className={filter === "PENDING" ? "selected" : ""}
            onClick={() => setFilter("PENDING")}
          >
            待我审核
          </button>
          <button
            className={filter === "all" ? "selected" : ""}
            onClick={() => setFilter("all")}
          >
            全部记录
          </button>
        </div>
        <p className="muted">审批只授权当前参数、资源和版本。</p>
      </div>
      {!rows.length ? (
        <Empty title="当前没有待处理的审批">
          需要人工批准的工具操作会自动进入这里。
        </Empty>
      ) : (
        rows.map((a) => (
          <section className="approval-card" key={a.id}>
            <div className="approval-icon">✓</div>
            <div>
              <h3>
                {w.tools.find((t) => t.id === a.binding.tool_id)?.name ||
                  a.binding.tool_id}
              </h3>
              <p>
                请求人：{a.requester_user_id} · 目标：{a.binding.resource_id}
              </p>
              <small>有效期至 {stamp(a.binding.expires_at)}</small>
            </div>
            <Badge value={a.status} />
            <button className="secondary" onClick={() => open(a)}>
              检查操作 →
            </button>
          </section>
        ))
      )}
      {selected && (
        <Modal
          title="检查并审批操作"
          close={() => {
            setSelected(undefined);
            setInvocation(undefined);
          }}
        >
          <div className="notice">
            核对目标资源、参数与成果。本次决定只能用于这一项操作。
          </div>
          <dl className="facts">
            <dt>请求人</dt>
            <dd>{selected.requester_user_id}</dd>
            <dt>资源 / 版本</dt>
            <dd>
              {selected.binding.resource_id} /{" "}
              {selected.binding.resource_version}
            </dd>
            <dt>代码版本</dt>
            <dd className="mono">
              {selected.binding.commit_sha || "本操作未绑定 Git Commit"}
            </dd>
            <dt>策略 / 工具版本</dt>
            <dd>
              {selected.binding.policy_version} /{" "}
              {selected.binding.tool_schema_version}
            </dd>
            <dt>审批有效期</dt>
            <dd>{stamp(selected.binding.expires_at)}</dd>
            <dt>绑定摘要</dt>
            <dd className="mono">{selected.binding_digest}</dd>
          </dl>
          <h3>本次操作参数</h3>
          {invocation ? (
            <Json data={invocation.parameters} />
          ) : (
            <p>正在读取…</p>
          )}
          <h3>关联成果</h3>
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
            <p className="muted">本次请求没有关联成果。</p>
          )}
          {selected.status === "PENDING" &&
          selected.requester_user_id !== w.me.id ? (
            <Form
              submit="提交审批决定"
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
              <Field label="审批决定">
                <select name="decision">
                  <option value="APPROVE">批准这一次操作</option>
                  <option value="REJECT">拒绝执行</option>
                </select>
              </Field>
              <Field label="审核意见">
                <textarea name="reason" required />
              </Field>
            </Form>
          ) : (
            <div className="notice">
              {selected.requester_user_id === w.me.id &&
              selected.status === "PENDING"
                ? "你是本次请求的委托人，需要另一位审核人作出决定。"
                : `${label(selected.status)} · ${selected.decided_by_user_id || ""} ${selected.reason || ""}`}
            </div>
          )}
          {invocation && (
            <div className="record-row">
              <span>工具执行状态</span>
              <Badge value={invocation.status} />
              <Action run={() => open(selected)}>更新状态</Action>
            </div>
          )}
        </Modal>
      )}
    </>
  );
}
export function Agents({ w }: { w: Workspace }) {
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
      <div className="toolbar">
        <p className="muted">注册客户端，为执行代理委托有限的权限。</p>
        <button className="primary" onClick={() => setCreating(true)}>
          ＋ 注册执行代理
        </button>
      </div>
      {!agents.length ? (
        <Empty title="连接你的执行客户端">
          注册客户端信息，再创建短期 Session 授权。
        </Empty>
      ) : (
        <div className="context-grid">
          {agents.map((a) => (
            <section className="context-card" key={a.id}>
              <div className="context-icon">⌘</div>
              <h3>{a.client_name}</h3>
              <p>
                {a.client_version} · {a.adapter_id}
              </p>
              <small>{a.registered_by_user_id}</small>
              <footer>
                <span>{short(a.id)}</span>
                <button className="text-button" onClick={() => setGranting(a)}>
                  授权执行 →
                </button>
              </footer>
            </section>
          ))}
        </div>
      )}
      <section className="panel section-space">
        <div className="section-title">
          <h2>执行授权 Session</h2>
          <button
            className="text-button"
            onClick={() => load().catch(setError)}
          >
            刷新
          </button>
        </div>
        {!sessions.length ? (
          <p className="muted">尚未创建执行授权。</p>
        ) : (
          sessions.map((s) => (
            <div className="record-row" key={s.id}>
              <span>
                {agents.find((a) => a.id === s.agent_id)?.client_name ||
                  s.agent_id}
                <small>
                  {s.delegated_by_user_id} · 到期 {stamp(s.expires_at)}
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
                    撤销授权
                  </Action>
                )}
            </div>
          ))
        )}
      </section>
      {creating && (
        <Modal title="注册执行代理" close={() => setCreating(false)}>
          <Form
            submit="注册代理"
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
            <Field label="客户端名称">
              <input
                name="client"
                required
                placeholder="使用的 AI 客户端名称"
              />
            </Field>
            <Field label="客户端版本">
              <input name="version" required placeholder="填写实际安装版本" />
            </Field>
            <p className="notice">
              通过 ACCP Local Bridge
              接入，注册信息本身不代表已经完成兼容性验证。
            </p>
          </Form>
        </Modal>
      )}
      {granting && (
        <Modal
          title={`授权 ${granting.client_name} 执行`}
          close={() => setGranting(undefined)}
        >
          <Form
            submit="创建短期授权"
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
            <Field label="授权时长">
              <select name="hours">
                <option value="1">1 小时</option>
                <option value="4">4 小时</option>
                <option value="8">8 小时</option>
              </select>
            </Field>
            <fieldset>
              <legend>权限范围</legend>
              {[
                { value: "tasks:read", name: "读取任务与执行记录" },
                { value: "context:read", name: "读取上下文和执行快照" },
                { value: "runs:claim", name: "领取已分配任务" },
                { value: "runs:write", name: "心跳与执行报告" },
                { value: "artifacts:write", name: "上传执行成果" },
                { value: "events:read", name: "订阅项目事件" },
                { value: "tools:invoke", name: "通过网关请求工具操作" },
              ].map((s) => (
                <label className="checkbox" key={s.value}>
                  <input
                    type="checkbox"
                    name="scopes"
                    value={s.value}
                    defaultChecked={s.value !== "tools:invoke"}
                  />
                  {s.name}
                </label>
              ))}
            </fieldset>
            <p className="muted">
              委托人：{w.me.display_name || w.me.id}
              。高风险操作仍需独立人类审批。
            </p>
          </Form>
        </Modal>
      )}
      {grant && (
        <Modal title="执行授权已创建" close={() => setGrant(undefined)}>
          <div className="notice">
            凭证仅显示在当前窗口，请妥善交给本地
            Bridge；关闭后可撤销并重新授权。
          </div>
          <Field label="Session ID">
            <input readOnly value={grant.session.id} />
          </Field>
          <Field label="访问凭证">
            <input type="password" readOnly value={grant.access_token} />
          </Field>
          <Action run={() => navigator.clipboard.writeText(grant.access_token)}>
            复制凭证
          </Action>
          <p>
            本地 Bridge 使用 <code>ACCP_URL</code> 与{" "}
            <code>ACCP_SESSION_TOKEN</code> 连接平台，并将{" "}
            <code>ACCP_ADAPTER_MANIFEST</code> 指向与注册信息一致的 Adapter
            manifest JSON 文件。通过 <code>accp-bridge stdio</code>{" "}
            供客户端使用。
          </p>
          <small>有效期至 {stamp(grant.expires_at)}</small>
        </Modal>
      )}
    </>
  );
}
export function Members({ w }: { w: Workspace }) {
  const [selected, setSelected] = useState<Membership>();
  return (
    <>
      <div className="toolbar">
        <p className="muted">企业身份与项目角色共同决定访问权限。</p>
      </div>
      <section className="panel table-wrap">
        <table>
          <thead>
            <tr>
              <th>成员</th>
              <th>项目角色</th>
              <th>状态</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {w.members.map((m) => (
              <tr key={m.id}>
                <td>
                  <strong>{m.display_name || m.id}</strong>
                  <small>{m.id}</small>
                </td>
                <td>{m.roles.map(label).join(" / ")}</td>
                <td>
                  <Badge value={m.active ? "ACTIVE" : "REVOKED"} />
                </td>
                <td>
                  {w.roles.includes("ADMIN") && (
                    <button
                      className="text-button"
                      onClick={() => setSelected(m)}
                    >
                      管理角色
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {selected && (
        <Modal
          title={`管理 ${selected.display_name || selected.id}`}
          close={() => setSelected(undefined)}
        >
          <Form
            submit="保存成员权限"
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
              <legend>角色</legend>
              {["ADMIN", "MEMBER", "REVIEWER", "VIEWER"].map((role) => (
                <label className="checkbox" key={role}>
                  <input
                    type="checkbox"
                    name="roles"
                    value={role}
                    defaultChecked={selected.roles.includes(role)}
                  />
                  {label(role)}
                </label>
              ))}
            </fieldset>
            <label className="checkbox">
              <input
                type="checkbox"
                name="active"
                defaultChecked={selected.active}
              />
              启用成员访问
            </label>
            <Field label="变更原因">
              <textarea name="reason" required />
            </Field>
          </Form>
        </Modal>
      )}
    </>
  );
}
export function Audit({ w }: { w: Workspace }) {
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
      <Empty title="审计记录需要审核权限">请联系项目管理员授予相应角色。</Empty>
    );
  return (
    <>
      {error !== undefined && <Message error={error} />}
      <div className="toolbar">
        <p className="muted">查看操作者、责任人、执行依据和审核结果。</p>
        <input
          className="search"
          aria-label="搜索审计记录"
          placeholder="搜索操作者、任务或操作…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <section className="panel table-wrap">
        <table>
          <thead>
            <tr>
              <th>时间</th>
              <th>操作</th>
              <th>人类责任主体</th>
              <th>结果</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows
              .filter((r) =>
                JSON.stringify(r).toLowerCase().includes(search.toLowerCase()),
              )
              .map((r) => (
                <tr key={r.id}>
                  <td className="nowrap">{stamp(r.occurred_at)}</td>
                  <td>
                    <strong>{r.action}</strong>
                    <small>{short(r.resource_id)}</small>
                  </td>
                  <td>
                    {r.accountable_user_id}
                    <small>{r.actor.kind}</small>
                  </td>
                  <td>
                    <Badge value={r.result} />
                  </td>
                  <td>
                    <button
                      className="text-button"
                      onClick={() => setSelected(r)}
                    >
                      追踪 →
                    </button>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </section>
      {selected && (
        <Modal title="审计责任链" close={() => setSelected(undefined)}>
          <dl className="facts">
            <dt>实际操作者</dt>
            <dd>
              {selected.actor.user_id ||
                selected.actor.agent_id ||
                selected.actor.service_id}
            </dd>
            <dt>人类责任主体</dt>
            <dd>{selected.accountable_user_id}</dd>
            <dt>Task Owner</dt>
            <dd>{selected.owner_user_id || "—"}</dd>
            <dt>执行 Run</dt>
            <dd>{selected.task_run_id || "—"}</dd>
            <dt>Context 快照</dt>
            <dd>{selected.context_snapshot_id || "—"}</dd>
            <dt>请求关联</dt>
            <dd>{selected.trace_id}</dd>
          </dl>
          <Json data={selected} />
        </Modal>
      )}
    </>
  );
}
export function Tools({ w }: { w: Workspace }) {
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
      <Field label="已配置工具">
        <select
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
        </select>
      </Field>
      <Field label="工具名称">
        <input name="name" required defaultValue={selected?.name} />
      </Field>
      <Field label="资源版本" hint="版本变化后，旧审批不能用于执行。">
        <input
          name="revision"
          required
          defaultValue={selected?.resource_version || "1"}
        />
      </Field>
      <label className="checkbox">
        <input
          type="checkbox"
          name="enabled"
          defaultChecked={selected ? selected.enabled : true}
        />
        允许请求此工具
      </label>
      <Field label="配置原因">
        <textarea name="reason" required />
      </Field>
    </>
  );
  return (
    <>
      {error !== undefined && <Message error={error} />}
      <div className="toolbar">
        <p className="muted">
          工具风险由受信配置决定，调用经过权限检查与审批。
        </p>
        {w.roles.includes("ADMIN") && (
          <button
            className="primary"
            onClick={() => {
              setSelected(undefined);
              setCreating(true);
            }}
          >
            ＋ 注册工具策略
          </button>
        )}
      </div>
      {!w.tools.length ? (
        <Empty title="尚未开放工具">
          管理员先配置下游工具端点与凭证，再为项目注册策略。
        </Empty>
      ) : (
        <div className="context-grid">
          {w.tools.map((t) => (
            <section className="context-card" key={t.id}>
              <div className="context-icon">⚙</div>
              <h3>{t.name}</h3>
              <Badge value={t.risk} />
              <p>
                {t.resource_id} · {t.resource_version}
              </p>
              <footer>
                <span>{t.enabled ? "已开放" : "已停用"}</span>
                {w.roles.includes("ADMIN") && (
                  <button
                    className="text-button"
                    onClick={() => {
                      setSelected(t);
                      setCreating(true);
                    }}
                  >
                    管理策略
                  </button>
                )}
              </footer>
            </section>
          ))}
        </div>
      )}
      <section className="panel section-space">
        <div className="section-title">
          <h2>工具操作记录</h2>
          <button
            className="text-button"
            onClick={() => load().catch(setError)}
          >
            刷新
          </button>
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
                  查询外部结果
                </Action>
              )}
            </div>
          ))
        ) : (
          <p className="muted">暂无可查看的操作记录。</p>
        )}
      </section>
      {creating && (
        <Modal
          title={selected ? "更新工具策略" : "注册工具策略"}
          close={() => setCreating(false)}
        >
          {!backends.length ? (
            <div className="notice">
              当前没有配置下游工具。请由部署管理员配置工具目录后重启 API 与
              Worker。
            </div>
          ) : (
            <Form
              submit="保存工具策略"
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
