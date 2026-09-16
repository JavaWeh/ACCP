import { useI18n } from "./i18n";
import {
  Avatar,
  Tabs,
  ProgressBar,
  ToggleButton,
  ToggleButtonGroup,
} from "@heroui/react";
import { useEffect, useState } from "react";
import type { Doc } from "./api";
import { short } from "./api";
import type { Workspace } from "./main";
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
  const { translate, label, number } = useI18n();

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
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4 [&>p]:text-sm [&>p]:text-slate-600">
        <ToggleButtonGroup
          aria-label={translate("筛选任务")}
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={[filter]}
          onSelectionChange={(keys) => setFilter(String([...keys][0]))}
        >
          <ToggleButton id="all">
            {translate("全部任务")}
            <small>{number(w.tasks.length)}</small>
          </ToggleButton>
          <ToggleButton id="mine">{translate("我负责的")}</ToggleButton>
        </ToggleButtonGroup>
        <Input
          className="w-full sm:ml-auto sm:max-w-72"
          aria-label={translate("搜索任务")}
          placeholder={translate("搜索任务…")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Button variant="primary" onClick={() => setCreating(true)}>
          {translate("＋ 创建任务")}
        </Button>
      </div>
      {!w.tasks.length ? (
        <Empty title={translate("还没有任务")}>
          {translate(
            "先明确目标、Owner、验收条件与上下文，再分配 Agent 执行。",
          )}
        </Empty>
      ) : (
        <div className="grid grid-cols-[repeat(7,280px)] items-start gap-4 overflow-x-auto pb-6">
          {columns.map((status) => (
            <section
              className="board-column min-h-80 rounded-xl bg-slate-100 p-3"
              key={status}
            >
              <h2>
                <span className={`column-dot dot-${status}`} />
                {label(status)}
                <small>
                  {number(tasks.filter((t) => t.status === status).length)}
                </small>
              </h2>
              <div>
                {tasks
                  .filter((t) => t.status === status)
                  .map((task) => (
                    <Button
                      variant="secondary"
                      className="task-card"
                      key={task.id}
                      onClick={() => setSelected(task.id)}
                    >
                      <span className="font-mono text-xs text-slate-600">
                        {short(task.id)}
                      </span>
                      <h3>{task.title}</h3>
                      <p>{task.objective}</p>
                      <div className="flex justify-between gap-2 text-xs text-slate-600">
                        <span>
                          ▧{" "}
                          {translate("{count} 项依据", {
                            count: task.context_version_ids.length,
                          })}
                        </span>
                        <span>
                          {translate("{count} 项验收", {
                            count: task.acceptance_criteria.length,
                          })}
                        </span>
                      </div>
                      <footer>
                        <Avatar size="sm" aria-hidden="true">
                          <Avatar.Fallback>
                            {String(
                              w.members.find((m) => m.id === task.owner_user_id)
                                ?.display_name || task.owner_user_id,
                            ).slice(0, 1)}
                          </Avatar.Fallback>
                        </Avatar>
                        <span>
                          {w.members.find((m) => m.id === task.owner_user_id)
                            ?.display_name || task.owner_user_id}
                        </span>
                        <span>→</span>
                      </footer>
                    </Button>
                  ))}
                {!tasks.some((t) => t.status === status) && (
                  <div className="py-12 text-center text-xs text-slate-600">
                    {translate("暂无任务")}
                  </div>
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
  const { translate } = useI18n();

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
    <Modal title={translate("创建协作任务")} close={close}>
      {error !== undefined && <Message error={error} />}
      <Form
        submit={translate("创建草稿")}
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
        <Field label={translate("任务标题")}>
          <Input
            name="title"
            required
            maxLength={200}
            placeholder={translate("例如：实现订单查询 API")}
          />
        </Field>
        <Field label={translate("目标与范围")}>
          <TextArea
            name="objective"
            required
            rows={3}
            placeholder={translate("说明预期结果和本次交付范围")}
          />
        </Field>
        <div className="grid grid-cols-1 gap-x-5 sm:grid-cols-2">
          <Field label={translate("人类负责人")}>
            <Select name="owner" defaultValue={w.me.id}>
              {w.members
                .filter((m) => m.active)
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.display_name || m.id}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label={translate("代码仓库")}>
            <Select name="repo" required>
              {repos.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.url}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field
          label={translate("验收条件")}
          hint={translate("每行一项；最终由 Owner 逐项确认。")}
        >
          <TextArea
            name="criteria"
            required
            rows={3}
            placeholder={translate(
              "能够按订单编号返回订单信息\n权限校验和测试通过",
            )}
          />
        </Field>
        <Field
          label={translate("执行依据")}
          hint={translate(
            "选择已发布的明确版本。任务领取后，输入会固定为执行快照。",
          )}
        >
          <Select name="contexts" multiple required>
            {versions.map((v) => (
              <option key={v.id} value={v.id}>
                {v.context_name} · {v.source_revision}
              </option>
            ))}
          </Select>
        </Field>
        {!versions.length && (
          <div className="notice">
            {translate("请先到「共享上下文」创建并发布需求或 API 版本。")}
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
  const { translate, label, stamp } = useI18n();

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
    <Modal title={task?.title || translate("任务详情")} close={close}>
      {error !== undefined && <Message error={error} />}{" "}
      {!task ? (
        <p>{translate("正在读取任务…")}</p>
      ) : (
        <>
          <div className="mb-5 flex flex-wrap items-center gap-3 text-sm text-slate-600">
            <Badge value={task.status} />
            <span>
              {translate("负责人：")}
              {w.members.find((m) => m.id === task.owner_user_id)
                ?.display_name || task.owner_user_id}
            </span>
            <span>
              {translate("版本 {version}", { version: task.version })}
            </span>
          </div>
          <p className="mb-5 text-sm leading-7 text-slate-600">
            {task.objective}
          </p>
          <Tabs
            selectedKey={tab}
            onSelectionChange={(key) => setTab(String(key))}
          >
            <Tabs.List aria-label={translate("任务详情")}>
              {[
                { id: "overview", name: translate("任务与执行") },
                { id: "evidence", name: translate("成果与验收") },
                { id: "history", name: translate("报告与记录") },
              ].map((t) => (
                <Tabs.Tab key={t.id} id={t.id}>
                  {t.name}
                  <Tabs.Indicator />
                </Tabs.Tab>
              ))}
            </Tabs.List>
            <Tabs.Panel id="overview">
              <h3>{translate("验收条件")}</h3>
              <ul className="criteria">
                {task.acceptance_criteria.map((c: string, i: number) => (
                  <li key={i}>
                    <span>{task.status === "DONE" ? "✓" : "○"}</span>
                    {c}
                  </li>
                ))}
              </ul>
              <h3>{translate("执行记录")}</h3>
              {!runs.length ? (
                <p className="text-sm leading-6 text-slate-600">
                  {translate("尚未领取。分配后，由已授权的 Agent 领取任务。")}
                </p>
              ) : (
                runs.map((r) => (
                  <div key={r.id} className="record-row">
                    <span>
                      {translate("第 {count} 次执行", { count: r.attempt })}
                      <small>
                        {short(r.id)} · {r.agent_id}
                      </small>
                    </span>
                    <Badge value={r.status} />
                  </div>
                ))
              )}
              <h3>{translate("任务依赖")}</h3>
              {dependencies.length ? (
                dependencies.map((d) => (
                  <div key={d.id} className="record-row">
                    <span>
                      {w.tasks.find((t) => t.id === d.predecessor_task_id)
                        ?.title || d.predecessor_task_id}
                      <small>
                        {d.condition.kind === "TASK_DONE"
                          ? translate("等待前置任务完成")
                          : translate("等待 {kind} 获得接受", {
                              kind: label(d.condition.artifact_kind),
                            })}
                      </small>
                    </span>
                  </div>
                ))
              ) : (
                <p className="text-sm leading-6 text-slate-600">
                  {translate("无前置任务依赖。")}
                </p>
              )}
              {canChange &&
                ["DRAFT", "READY", "BLOCKED"].includes(task.status) && (
                  <details>
                    <summary>{translate("配置前置依赖")}</summary>
                    <Form
                      submit={translate("添加依赖")}
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
                      <Field label={translate("前置任务")}>
                        <Select name="predecessor" required>
                          {w.tasks
                            .filter((t) => t.id !== id)
                            .map((t) => (
                              <option key={t.id} value={t.id}>
                                {t.title}
                              </option>
                            ))}
                        </Select>
                      </Field>
                      <Field label={translate("满足条件")}>
                        <Select name="condition">
                          <option value="TASK_DONE">
                            {translate("任务完成人工验收")}
                          </option>
                          <option value="API_DOCUMENT">
                            {translate("API 文档获得接受")}
                          </option>
                          <option value="TEST_REPORT">
                            {translate("测试报告获得接受")}
                          </option>
                        </Select>
                      </Field>
                    </Form>
                  </details>
                )}
              {canChange && (
                <div className="mt-6 flex flex-wrap items-center gap-4">
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
                      {runs.length
                        ? translate("授权重新执行")
                        : translate("分配并提交执行")}
                    </Action>
                  )}
                  {!["DONE", "CANCELED"].includes(task.status) && (
                    <details>
                      <summary className="text-danger">
                        {translate("取消任务")}
                      </summary>
                      <Form
                        submit={translate("确认取消任务")}
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
                        <Field label={translate("取消原因")}>
                          <Input name="reason" required />
                        </Field>
                      </Form>
                    </details>
                  )}
                </div>
              )}
            </Tabs.Panel>
            <Tabs.Panel id="evidence">
              {!artifacts.length ? (
                <Empty title={translate("等待执行成果")}>
                  {translate("Agent 需要提交可核验的文档、代码或测试证据。")}
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
                  <div className="mt-6 rounded-xl border border-slate-200 bg-slate-50 p-5">
                    <h3>{translate("Owner 最终验收")}</h3>
                    <Form
                      submit={translate("提交验收决定")}
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
                        <legend>{translate("逐项检查验收条件")}</legend>
                        {task.acceptance_criteria.map(
                          (c: string, i: number) => (
                            <Checkbox key={i} name={`criterion_${i}`}>
                              {c}
                            </Checkbox>
                          ),
                        )}
                      </fieldset>
                      <fieldset>
                        <legend>{translate("绑定本次验收成果")}</legend>
                        {artifacts.map((a) => (
                          <Checkbox
                            key={a.id}
                            name="artifact"
                            value={a.id}
                            defaultSelected
                          >
                            {label(a.kind)} · {short(a.id)} · v{a.version}
                          </Checkbox>
                        ))}
                      </fieldset>
                      <Field label={translate("验收决定")}>
                        <Select name="decision">
                          <option value="ACCEPT">
                            {translate("接受成果，完成任务")}
                          </option>
                          <option value="REJECT">
                            {translate("退回修改")}
                          </option>
                        </Select>
                      </Field>
                      <Field label={translate("审核意见")}>
                        <TextArea
                          name="reason"
                          required
                          placeholder={translate(
                            "说明验收证据或需要修改的内容",
                          )}
                        />
                      </Field>
                    </Form>
                  </div>
                )}
            </Tabs.Panel>
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
                      {r.decision === "ACCEPT"
                        ? translate("接受")
                        : translate("退回")}{" "}
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
          </Tabs>
        </>
      )}
    </Modal>
  );
}
