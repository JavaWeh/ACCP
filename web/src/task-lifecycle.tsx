import { useState } from "react";
import type { Doc } from "./api";
import type { Workspace } from "./main";
import {
  Button,
  Field,
  Form,
  Input,
  Select,
  TextArea,
  text,
  Json,
  Message,
} from "./ui";

export function TaskLifecycle({
  w,
  task,
  refreshed,
}: {
  w: Workspace;
  task: Doc;
  refreshed: () => Promise<void>;
}) {
  const [action, setAction] = useState(""),
    [history, setHistory] = useState<Doc[]>([]),
    [error, setError] = useState<unknown>();
  const ended = ["DONE", "CANCELED"].includes(task.status);
  const choices = task.archived
    ? [["restore", "恢复归档任务"]]
    : [
        ...(task.status === "DRAFT" ? [["changes", "编辑草稿"]] : []),
        ["owner-transfers", "移交 Owner"],
        ...(!["DONE", "IN_REVIEW"].includes(task.status)
          ? [["inputs", "更新执行输入"]]
          : []),
        ...(ended ? [["archive", "归档任务"]] : []),
      ];
  return (
    <details className="my-5 rounded-lg border border-slate-200 p-4">
      <summary>任务变更与责任记录{task.archived ? " · 已归档" : ""}</summary>
      <p className="my-3 text-sm text-slate-600">
        执行中的任务须先停止并核对在途操作。移交和输入更新保留已有
        Run、快照及成果的责任主体。
      </p>
      <Select aria-label="变更类型" value={action} onChange={setAction}>
        <option value="">选择操作</option>
        {choices.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </Select>
      {action && (
        <Form
          key={task.version + action}
          submit="确认变更"
          action={async (data) => {
            const body: Record<string, unknown> = {
              reason: text(data, "reason"),
            };
            if (action === "owner-transfers")
              body.owner_user_id = text(data, "owner");
            if (action === "changes" || action === "inputs") {
              body.title = text(data, "title");
              body.objective = text(data, "objective");
              body.acceptance_criteria = text(data, "criteria")
                .split("\n")
                .map((s) => s.trim())
                .filter(Boolean);
            }
            if (action === "inputs") {
              body.repository_id = text(data, "repository");
              body.context_version_ids = text(data, "versions")
                .split(/[,\s]+/)
                .filter(Boolean);
            }
            await w.api.call(`/tasks/${task.id}/${action}`, body, task.version);
            setAction("");
            await refreshed();
          }}
        >
          {(action === "changes" || action === "inputs") && (
            <>
              <Field label="任务标题">
                <Input name="title" defaultValue={task.title} required />
              </Field>
              <Field label="任务目标">
                <TextArea
                  name="objective"
                  defaultValue={task.objective}
                  required
                />
              </Field>
              <Field label="验收条件（每行一项）">
                <TextArea
                  name="criteria"
                  defaultValue={task.acceptance_criteria.join("\n")}
                  required
                />
              </Field>
            </>
          )}
          {action === "owner-transfers" && (
            <Field label="新 Owner">
              <Select name="owner" required>
                {w.members
                  .filter((m) => m.active)
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.display_name}
                    </option>
                  ))}
              </Select>
            </Field>
          )}
          {action === "inputs" && (
            <>
              <Field label="项目仓库标识">
                <Input
                  name="repository"
                  defaultValue={task.repository_id}
                  required
                />
              </Field>
              <Field label="Context 版本标识（每行一项）">
                <TextArea
                  name="versions"
                  defaultValue={task.context_version_ids.join("\n")}
                  required
                />
              </Field>
            </>
          )}
          <Field label="变更原因">
            <TextArea name="reason" required maxLength={2000} />
          </Field>
        </Form>
      )}
      <Button
        variant="ghost"
        onPress={async () => {
          try {
            const page = await w.api.call<{ items: Doc[] }>(
              `/tasks/${task.id}/changes?limit=25`,
            );
            setHistory(page.items);
            setError(undefined);
          } catch (e) {
            setError(e);
          }
        }}
      >
        查看变更记录
      </Button>
      {error !== undefined && <Message error={error} />}
      {history.map((h) => (
        <details key={h.id}>
          <summary>
            v{h.version} · {h.actor_user_id} · {h.reason}
          </summary>
          <Json data={{ before: h.before, after: h.after }} />
        </details>
      ))}
    </details>
  );
}
