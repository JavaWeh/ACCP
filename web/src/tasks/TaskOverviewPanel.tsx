import { useI18n, LocalizedError } from "../i18n";
import { Tabs } from "@heroui/react";
import type { Doc } from "../api";
import { short } from "../api";
import type { Workspace } from "../main";
import {
  Input,
  Select,
  TextArea,
  Checkbox,
  Action,
  Badge,
  Field,
  Form,
  text,
} from "../ui";

export function TaskOverviewPanel({
  w,
  id,
  task,
  runs,
  dependencies,
  canChange,
  editRepos,
  editVersions,
  dependencySearch,
  setDependencySearch,
  dependencyCandidates,
  refreshed,
}: {
  w: Workspace;
  id: string;
  task: Doc;
  runs: Doc[];
  dependencies: Doc[];
  canChange: boolean;
  editRepos: Doc[];
  editVersions: Doc[];
  dependencySearch: string;
  setDependencySearch: (value: string) => void;
  dependencyCandidates: Doc[];
  refreshed: () => Promise<void>;
}) {
  const { translate, label } = useI18n();
  return (
    <Tabs.Panel id="overview">
      {canChange &&
        !task.archived &&
        ["DRAFT", "READY", "BLOCKED"].includes(task.status) && (
          <div className="mb-5 space-y-3">
            <details>
              <summary>{translate("编辑任务输入")}</summary>
              <Form
                submit={translate("保存并返回草稿")}
                action={async (data) => {
                  const criteria = text(data, "criteria")
                    .split("\n")
                    .map((value) => value.trim())
                    .filter(Boolean);
                  const contextIDs = data.getAll("contexts");
                  if (!criteria.length || !contextIDs.length)
                    throw new LocalizedError("请填写验收条件并选择执行依据。");
                  await w.api.call(
                    `/tasks/${id}/edit`,
                    {
                      title: text(data, "title"),
                      objective: text(data, "objective"),
                      repository_id: text(data, "repo"),
                      acceptance_criteria: criteria,
                      context_version_ids: contextIDs,
                      reason: text(data, "reason"),
                    },
                    task.version,
                  );
                  await refreshed();
                }}
              >
                <Field label={translate("任务标题")}>
                  <Input
                    name="title"
                    required
                    maxLength={200}
                    defaultValue={task.title}
                  />
                </Field>
                <Field label={translate("目标与范围")}>
                  <TextArea
                    name="objective"
                    required
                    rows={4}
                    defaultValue={task.objective}
                  />
                </Field>
                <Field label={translate("代码仓库")}>
                  <Select
                    name="repo"
                    required
                    defaultValue={task.repository_id}
                  >
                    {editRepos.map((repo) => (
                      <option key={repo.id} value={repo.id}>
                        {repo.url}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={translate("验收条件（每行一项）")}>
                  <TextArea
                    name="criteria"
                    required
                    rows={4}
                    defaultValue={task.acceptance_criteria.join("\n")}
                  />
                </Field>
                <fieldset>
                  <legend>{translate("执行依据")}</legend>
                  {editVersions.map((version) => (
                    <Checkbox
                      key={version.id}
                      name="contexts"
                      value={version.id}
                      defaultSelected={task.context_version_ids.includes(
                        version.id,
                      )}
                    >
                      {version.source_revision} · {short(version.id)}
                    </Checkbox>
                  ))}
                </fieldset>
                <Field label={translate("修改原因")}>
                  <Input name="reason" required />
                </Field>
                <p className="text-sm text-slate-600">
                  {translate(
                    "修改后须由负责人重新提交；历史执行快照不会改变。",
                  )}
                </p>
              </Form>
            </details>
            <details>
              <summary>{translate("移交负责人")}</summary>
              <Form
                submit={translate("确认移交")}
                action={async (data) => {
                  await w.api.call(
                    `/tasks/${id}/transfer`,
                    {
                      owner_user_id: text(data, "owner"),
                      reason: text(data, "reason"),
                    },
                    task.version,
                  );
                  await refreshed();
                }}
              >
                <Field label={translate("新负责人")}>
                  <Select name="owner" required>
                    {w.members
                      .filter(
                        (member) =>
                          member.active && member.id !== task.owner_user_id,
                      )
                      .map((member) => (
                        <option key={member.id} value={member.id}>
                          {member.display_name || member.id}
                        </option>
                      ))}
                  </Select>
                </Field>
                <Field label={translate("移交原因")}>
                  <Input name="reason" required />
                </Field>
              </Form>
            </details>
          </div>
        )}
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
              {w.tasks.find((t) => t.id === d.predecessor_task_id)?.title ||
                d.predecessor_task_id}
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
      {canChange && ["DRAFT", "READY", "BLOCKED"].includes(task.status) && (
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
            <Field label={translate("搜索前置任务")}>
              <Input
                value={dependencySearch}
                onChange={(event) => setDependencySearch(event.target.value)}
                placeholder={translate("输入任务名称查找…")}
              />
            </Field>
            <Field label={translate("前置任务")}>
              <Select name="predecessor" required>
                {dependencyCandidates.map((t) => (
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
          {(task.archived || ["DONE", "CANCELED"].includes(task.status)) && (
            <Action
              run={async () => {
                await w.api.call(
                  `/tasks/${id}/commands`,
                  {
                    command: task.archived ? "RESTORE" : "ARCHIVE",
                    reason: task.archived
                      ? "Restore task to active list"
                      : "Archive terminal task",
                  },
                  task.version,
                );
                await refreshed();
              }}
            >
              {task.archived ? translate("恢复任务") : translate("归档任务")}
            </Action>
          )}
          {["DRAFT", "BLOCKED"].includes(task.status) && (
            <Action
              run={async () => {
                const assignments = await w.api.all(`/tasks/${id}/assignments`);
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
                    reason: "Owner submitted execution from the console",
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
              <summary className="text-danger">{translate("取消任务")}</summary>
              <Form
                submit={translate("确认取消任务")}
                action={async (data) => {
                  const current = await w.api.call(`/tasks/${id}`);
                  await w.api.call(
                    `/tasks/${id}/commands`,
                    {
                      command: "CANCEL",
                      reason: text(data, "reason"),
                    },
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
  );
}
