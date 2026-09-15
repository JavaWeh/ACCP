import { useEffect, useState } from "react";
import type { Doc } from "./api";
import { label, stamp, short } from "./api";
import type { Workspace } from "./main";
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

const columns = [
  "DRAFT",
  "BLOCKED",
  "READY",
  "RUNNING",
  "IN_REVIEW",
  "DONE",
  "CANCELED",
];
export function Tasks({ w }: { w: Workspace }) {
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const tasks = w.tasks.filter(
    (t) =>
      (filter === "all" || t.owner_user_id === w.me.id) &&
      `${t.title} ${t.objective}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <>
      <div className="toolbar">
        <div className="segmented">
          <button
            className={filter === "all" ? "selected" : ""}
            onClick={() => setFilter("all")}
          >
            全部任务 <small>{w.tasks.length}</small>
          </button>
          <button
            className={filter === "mine" ? "selected" : ""}
            onClick={() => setFilter("mine")}
          >
            我负责的
          </button>
        </div>
        <input
          className="search"
          aria-label="搜索任务"
          placeholder="搜索任务…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button className="primary" onClick={() => setCreating(true)}>
          ＋ 创建任务
        </button>
      </div>
      {!w.tasks.length ? (
        <Empty title="还没有任务">
          先明确目标、Owner、验收条件与上下文，再分配 Agent 执行。
        </Empty>
      ) : (
        <div className="board">
          {columns.map((status) => (
            <section className="board-column" key={status}>
              <h2>
                <span className={`column-dot dot-${status}`} />
                {label(status)}
                <small>{tasks.filter((t) => t.status === status).length}</small>
              </h2>
              <div>
                {tasks
                  .filter((t) => t.status === status)
                  .map((task) => (
                    <button
                      className="task-card"
                      key={task.id}
                      onClick={() => setSelected(task.id)}
                    >
                      <span className="card-id">{short(task.id)}</span>
                      <h3>{task.title}</h3>
                      <p>{task.objective}</p>
                      <div className="task-card-meta">
                        <span>▧ {task.context_version_ids.length} 项依据</span>
                        <span>{task.acceptance_criteria.length} 项验收</span>
                      </div>
                      <footer>
                        <span className="avatar small">
                          {String(
                            w.members.find((m) => m.id === task.owner_user_id)
                              ?.display_name || task.owner_user_id,
                          ).slice(0, 1)}
                        </span>
                        <span>
                          {w.members.find((m) => m.id === task.owner_user_id)
                            ?.display_name || task.owner_user_id}
                        </span>
                        <span>→</span>
                      </footer>
                    </button>
                  ))}
                {!tasks.some((t) => t.status === status) && (
                  <div className="column-empty">暂无任务</div>
                )}
              </div>
            </section>
          ))}
        </div>
      )}
      {creating && <CreateTask w={w} close={() => setCreating(false)} />}{" "}
      {selected && (
        <TaskDetail w={w} id={selected} close={() => setSelected("")} />
      )}
    </>
  );
}
function CreateTask({ w, close }: { w: Workspace; close: () => void }) {
  const [versions, setVersions] = useState<Doc[]>([]);
  const [repos, setRepos] = useState<Doc[]>([]);
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    Promise.all([
      Promise.all(
        w.contexts.map((c) =>
          w.api
            .all(`/contexts/${c.id}/versions`)
            .then((v) => v.map((x): Doc => ({ ...x, context_name: c.name }))),
        ),
      ),
      w.api.all(`/projects/${w.project.id}/repositories`),
    ])
      .then(([v, r]) => {
        setVersions(v.flat().filter((x) => x.status === "PUBLISHED"));
        setRepos(r);
      })
      .catch(setError);
  }, [w.api, w.project.id, w.contexts]);
  return (
    <Modal title="创建协作任务" close={close}>
      {error !== undefined && <Message error={error} />}
      <Form
        submit="创建草稿"
        onDone={close}
        action={async (data) => {
          await w.api.call(`/projects/${w.project.id}/tasks`, {
            title: text(data, "title"),
            objective: text(data, "objective"),
            owner_user_id: text(data, "owner"),
            repository_id: text(data, "repo"),
            acceptance_criteria: text(data, "criteria")
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean),
            context_version_ids: data.getAll("contexts"),
          });
          await w.refresh();
        }}
      >
        <Field label="任务标题">
          <input
            name="title"
            required
            maxLength={200}
            placeholder="例如：实现订单查询 API"
          />
        </Field>
        <Field label="目标与范围">
          <textarea
            name="objective"
            required
            rows={3}
            placeholder="说明预期结果和本次交付范围"
          />
        </Field>
        <div className="form-grid">
          <Field label="人类负责人">
            <select name="owner" defaultValue={w.me.id}>
              {w.members
                .filter((m) => m.active)
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.display_name || m.id}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="代码仓库">
            <select name="repo" required>
              {repos.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.url}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="验收条件" hint="每行一项；最终由 Owner 逐项确认。">
          <textarea
            name="criteria"
            required
            rows={3}
            placeholder="能够按订单编号返回订单信息&#10;权限校验和测试通过"
          />
        </Field>
        <Field
          label="执行依据"
          hint="选择已发布的明确版本。任务领取后，输入会固定为执行快照。"
        >
          <select
            name="contexts"
            multiple
            required
            size={Math.min(5, Math.max(2, versions.length))}
          >
            {versions.map((v) => (
              <option key={v.id} value={v.id}>
                {v.context_name} · {v.source_revision}
              </option>
            ))}
          </select>
        </Field>
        {!versions.length && (
          <div className="notice">
            请先到「共享上下文」创建并发布需求或 API 版本。
          </div>
        )}
      </Form>
    </Modal>
  );
}
function TaskDetail({
  w,
  id,
  close,
}: {
  w: Workspace;
  id: string;
  close: () => void;
}) {
  const [task, setTask] = useState<Doc>();
  const [runs, setRuns] = useState<Doc[]>([]);
  const [artifacts, setArtifacts] = useState<Doc[]>([]);
  const [reports, setReports] = useState<Doc[]>([]);
  const [reviews, setReviews] = useState<Doc[]>([]);
  const [dependencies, setDependencies] = useState<Doc[]>([]);
  const [error, setError] = useState<unknown>();
  const [tab, setTab] = useState("overview");
  async function load() {
    const [t, r, rev, dep] = await Promise.all([
      w.api.call(`/tasks/${id}`),
      w.api.all(`/tasks/${id}/runs`),
      w.api.all(`/tasks/${id}/reviews`),
      w.api.all(`/tasks/${id}/dependencies`),
    ]);
    setTask(t);
    r.sort((a, b) => b.attempt - a.attempt);
    setRuns(r);
    setReviews(rev);
    setDependencies(dep);
    if (r.length) {
      const [a, p] = await Promise.all([
        w.api.all(`/task-runs/${r[0].id}/artifacts`),
        w.api.all(`/task-runs/${r[0].id}/reports`),
      ]);
      setArtifacts(a);
      setReports(p);
    }
  }
  useEffect(() => {
    load().catch(setError);
  }, [id, w.api]);
  async function refreshed() {
    await load();
    await w.refresh();
  }
  const run = runs[0];
  const canChange =
    task?.owner_user_id === w.me.id || w.roles.includes("ADMIN");
  return (
    <Modal title={task?.title || "任务详情"} close={close}>
      {error !== undefined && <Message error={error} />}{" "}
      {!task ? (
        <p>正在读取任务…</p>
      ) : (
        <>
          <div className="detail-meta">
            <Badge value={task.status} />
            <span>
              Owner：
              {w.members.find((m) => m.id === task.owner_user_id)
                ?.display_name || task.owner_user_id}
            </span>
            <span>版本 {task.version}</span>
          </div>
          <p className="objective">{task.objective}</p>
          <div className="tabs">
            {[
              { id: "overview", name: "任务与执行" },
              { id: "evidence", name: "成果与验收" },
              { id: "history", name: "报告与记录" },
            ].map((t) => (
              <button
                key={t.id}
                className={tab === t.id ? "active" : ""}
                onClick={() => setTab(t.id)}
              >
                {t.name}
              </button>
            ))}
          </div>
          {tab === "overview" && (
            <>
              <h3>验收条件</h3>
              <ul className="criteria">
                {task.acceptance_criteria.map((c: string, i: number) => (
                  <li key={i}>
                    <span>{task.status === "DONE" ? "✓" : "○"}</span>
                    {c}
                  </li>
                ))}
              </ul>
              <h3>执行记录</h3>
              {!runs.length ? (
                <p className="muted">
                  尚未领取。分配后，由已授权的 Agent 领取任务。
                </p>
              ) : (
                runs.map((r) => (
                  <div key={r.id} className="record-row">
                    <span>
                      第 {r.attempt} 次执行
                      <small>
                        {short(r.id)} · {r.agent_id}
                      </small>
                    </span>
                    <Badge value={r.status} />
                  </div>
                ))
              )}
              <h3>任务依赖</h3>
              {dependencies.length ? (
                dependencies.map((d) => (
                  <div key={d.id} className="record-row">
                    <span>
                      {w.tasks.find((t) => t.id === d.predecessor_task_id)
                        ?.title || d.predecessor_task_id}
                      <small>
                        {d.condition.kind === "TASK_DONE"
                          ? "等待前置任务完成"
                          : `等待 ${label(d.condition.artifact_kind)} 获得接受`}
                      </small>
                    </span>
                  </div>
                ))
              ) : (
                <p className="muted">无前置任务依赖。</p>
              )}
              {canChange &&
                ["DRAFT", "READY", "BLOCKED"].includes(task.status) && (
                  <details>
                    <summary>配置前置依赖</summary>
                    <Form
                      submit="添加依赖"
                      action={async (data) => {
                        const current = await w.api.call(`/tasks/${id}`);
                        await w.api.call(
                          `/tasks/${id}/dependencies`,
                          {
                            predecessor_task_id: text(data, "predecessor"),
                            condition:
                              text(data, "condition") === "TASK_DONE"
                                ? { kind: "TASK_DONE" }
                                : {
                                    kind: "ARTIFACT_ACCEPTED",
                                    artifact_kind: text(data, "condition"),
                                  },
                          },
                          current.version,
                        );
                        await refreshed();
                      }}
                    >
                      <Field label="前置任务">
                        <select name="predecessor" required>
                          {w.tasks
                            .filter((t) => t.id !== id)
                            .map((t) => (
                              <option key={t.id} value={t.id}>
                                {t.title}
                              </option>
                            ))}
                        </select>
                      </Field>
                      <Field label="满足条件">
                        <select name="condition">
                          <option value="TASK_DONE">任务完成人工验收</option>
                          <option value="API_DOCUMENT">API 文档获得接受</option>
                          <option value="TEST_REPORT">测试报告获得接受</option>
                        </select>
                      </Field>
                    </Form>
                  </details>
                )}
              {canChange && (
                <div className="detail-actions">
                  {["DRAFT", "BLOCKED"].includes(task.status) && (
                    <Action
                      run={async () => {
                        const assignments = await w.api.all(
                          `/tasks/${id}/assignments`,
                        );
                        let current = await w.api.call(`/tasks/${id}`);
                        if (!assignments.length) {
                          await w.api.call(
                            `/tasks/${id}/assignments`,
                            { target: { capability_queue: "general" } },
                            current.version,
                          );
                          current = await w.api.call(`/tasks/${id}`);
                        }
                        await w.api.call(
                          `/tasks/${id}/commands`,
                          {
                            command: runs.length ? "RETRY" : "SUBMIT",
                            reason:
                              "Owner submitted execution from the console",
                          },
                          current.version,
                        );
                        await refreshed();
                      }}
                    >
                      {runs.length ? "授权重新执行" : "分配并提交执行"}
                    </Action>
                  )}
                  {!["DONE", "CANCELED"].includes(task.status) && (
                    <details>
                      <summary className="danger-text">取消任务</summary>
                      <Form
                        submit="确认取消任务"
                        action={async (data) => {
                          const current = await w.api.call(`/tasks/${id}`);
                          await w.api.call(
                            `/tasks/${id}/commands`,
                            { command: "CANCEL", reason: text(data, "reason") },
                            current.version,
                          );
                          await refreshed();
                        }}
                      >
                        <Field label="取消原因">
                          <input name="reason" required />
                        </Field>
                      </Form>
                    </details>
                  )}
                </div>
              )}
            </>
          )}
          {tab === "evidence" && (
            <>
              {!artifacts.length ? (
                <Empty title="等待执行成果">
                  Agent 需要提交可核验的文档、代码或测试证据。
                </Empty>
              ) : (
                artifacts.map((a) => (
                  <div className="record-row" key={a.id}>
                    <span>
                      {label(a.kind)}
                      <small>{short(a.id)}</small>
                    </span>
                    <Badge value={a.verification_status} />
                    <Badge value={a.acceptance_status} />
                  </div>
                ))
              )}
              {task.status === "IN_REVIEW" &&
                task.owner_user_id === w.me.id &&
                run && (
                  <div className="review-box">
                    <h3>Owner 最终验收</h3>
                    <Form
                      submit="提交验收决定"
                      action={async (data) => {
                        const selected = data
                          .getAll("artifact")
                          .map((value) =>
                            artifacts.find((a) => a.id === value)!,
                          );
                        await w.api.call(
                          `/tasks/${id}/reviews`,
                          {
                            decision: text(data, "decision"),
                            task_run_id: run.id,
                            artifacts: selected.map((a) => ({
                              artifact_id: a.id,
                              version: a.version,
                              content_digest: a.content_digest,
                            })),
                            acceptance_checks: task.acceptance_criteria.map(
                              (_: string, i: number) =>
                                data.has(`criterion_${i}`),
                            ),
                            reason: text(data, "reason"),
                          },
                          task.version,
                        );
                        await refreshed();
                      }}
                    >
                      <fieldset>
                        <legend>逐项检查验收条件</legend>
                        {task.acceptance_criteria.map(
                          (c: string, i: number) => (
                            <label key={i} className="checkbox">
                              <input type="checkbox" name={`criterion_${i}`} />
                              {c}
                            </label>
                          ),
                        )}
                      </fieldset>
                      <fieldset>
                        <legend>绑定本次验收成果</legend>
                        {artifacts.map((a) => (
                          <label key={a.id} className="checkbox">
                            <input
                              type="checkbox"
                              name="artifact"
                              value={a.id}
                              defaultChecked
                            />
                            {label(a.kind)} · {short(a.id)} · v{a.version}
                          </label>
                        ))}
                      </fieldset>
                      <Field label="验收决定">
                        <select name="decision">
                          <option value="ACCEPT">接受成果，完成任务</option>
                          <option value="REJECT">退回修改</option>
                        </select>
                      </Field>
                      <Field label="审核意见">
                        <textarea
                          name="reason"
                          required
                          placeholder="说明验收证据或需要修改的内容"
                        />
                      </Field>
                    </Form>
                  </div>
                )}
            </>
          )}
          {tab === "history" && (
            <>
              <h3>执行报告</h3>
              {reports.length ? (
                reports.map((r) => (
                  <div className="timeline-item" key={r.id}>
                    <strong>{r.kind}</strong>
                    <small>{stamp(r.created_at)}</small>
                    <p>{r.message || r.acceptance_report || r.error_code}</p>
                    {r.progress_percent !== undefined && (
                      <progress value={r.progress_percent} max="100" />
                    )}
                  </div>
                ))
              ) : (
                <p className="muted">暂无执行报告。</p>
              )}
              <h3>人工验收记录</h3>
              {reviews.length ? (
                reviews.map((r) => (
                  <div className="timeline-item" key={r.id}>
                    <strong>
                      {r.decision === "ACCEPT" ? "接受" : "退回"} ·{" "}
                      {r.reviewed_by_user_id}
                    </strong>
                    <small>{stamp(r.created_at)}</small>
                    <p>{r.reason}</p>
                  </div>
                ))
              ) : (
                <p className="muted">暂无验收记录。</p>
              )}
              <details>
                <summary>任务与执行来源</summary>
                <Json data={{ task, runs }} />
              </details>
            </>
          )}
        </>
      )}
    </Modal>
  );
}
