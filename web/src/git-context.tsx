import { useState } from "react";
import type { Workspace } from "./main";
import type { Doc } from "./api";
import { usePage } from "./use-page";
import { navigate } from "./navigation";
import {
  Action,
  Button,
  Field,
  Form,
  Input,
  Json,
  Modal,
  Select,
  text,
} from "./ui";

export function GitContextCreate({
  w,
  close,
}: {
  w: Workspace;
  close: () => void;
}) {
  const repositories = usePage(
    w,
    `/projects/${w.project.id}/repositories`,
    "git_repository_cursor",
  );
  return (
    <Modal title="登记 Git 来源" close={close}>
      <Form
        submit="登记来源"
        onDone={close}
        action={async (data) => {
          await w.api.call(`/projects/${w.project.id}/git-contexts`, {
            name: text(data, "name"),
            type: text(data, "type"),
            repository_id: text(data, "repository"),
            path: text(data, "path"),
            ref: text(data, "ref"),
            reason: text(data, "reason"),
          });
          await w.refresh();
        }}
      >
        <Field label="名称">
          <Input name="name" required maxLength={200} />
        </Field>
        <Field label="类型">
          <Select name="type">
            {["REQUIREMENT", "API", "DB_SCHEMA", "ADR", "PROJECT_STANDARD"].map(
              (v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ),
            )}
          </Select>
        </Field>
        <Field label="已登记仓库">
          <Select name="repository" required>
            {repositories.items.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name || r.url}
              </option>
            ))}
          </Select>
        </Field>
        {repositories.controls}
        <Field label="文件路径">
          <Input
            name="path"
            required
            placeholder="docs/api.md"
            maxLength={1024}
          />
        </Field>
        <Field label="分支、标签或 commit">
          <Input name="ref" defaultValue="main" required maxLength={200} />
        </Field>
        <Field label="登记原因">
          <Input name="reason" required maxLength={2000} />
        </Field>
        <p>
          仅读取 UTF-8 文本，最大 256 KiB。同步会先固定
          commit；候选版本需人工发布。
        </p>
      </Form>
    </Modal>
  );
}

export function GitContextSync({
  w,
  context,
  onDone,
}: {
  w: Workspace;
  context: Doc;
  onDone: () => Promise<void>;
}) {
  const [current, setCurrent] = useState<Doc>();
  const [source, setSource] = useState<Doc>();
  return (
    <section>
      <Action
        run={async () => {
          const [c, s] = await Promise.all([
            w.api.call(`/contexts/${context.id}`),
            w.api.call(`/contexts/${context.id}/source`),
          ]);
          setCurrent(c);
          setSource(s);
        }}
      >
        读取来源和当前版本
      </Action>
      {current && source && (
        <>
          <Json data={source} />
          <Form
            submit="同步为候选版本"
            action={async (data) => {
              await w.api.call(
                `/contexts/${context.id}/source-sync`,
                { ref: text(data, "ref"), reason: text(data, "reason") },
                current.version,
              );
              setCurrent(undefined);
              await onDone();
            }}
          >
            <Field label="读取 ref">
              <Input
                name="ref"
                defaultValue={source.ref}
                required
                maxLength={200}
              />
            </Field>
            <Field label="同步原因">
              <Input name="reason" required maxLength={2000} />
            </Field>
            <p>
              基于 Context v{current.version}
              。版本冲突需重新读取来源；相同内容复用已有版本。
            </p>
          </Form>
        </>
      )}
    </section>
  );
}

export function GitCandidate({
  w,
  context,
  version,
}: {
  w: Workspace;
  context: Doc;
  version: Doc;
}) {
  const [diff, setDiff] = useState<Doc>();
  const [show, setShow] = useState(false);
  const impact = usePage(
    w,
    `/contexts/${context.id}/versions/${version.id}/impact`,
    "git_impact_cursor",
    show,
  );
  return (
    <section>
      <Action
        run={async () => {
          setDiff(
            await w.api.call(
              `/contexts/${context.id}/versions/${version.id}/diff`,
            ),
          );
          setShow(true);
        }}
      >
        查看差异与任务影响
      </Action>
      {show && diff && (
        <div>
          <Json data={version.git_provenance} />
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <h4>当前发布版本</h4>
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap">
                {diff.before || "（无）"}
              </pre>
            </div>
            <div>
              <h4>候选正文</h4>
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap">
                {diff.after}
              </pre>
            </div>
          </div>
          <h4>仍引用其他版本的任务</h4>
          <p>发布后需由 Owner 明确更新任务输入。活跃 Run 的快照保持不变。</p>
          {impact.controls}
          {impact.items.map((task) => (
            <Button
              key={task.id}
              onPress={() => navigate({ page: "tasks", task: task.id })}
            >
              {task.title}
            </Button>
          ))}
          {!impact.items.length && <p>本页暂无受影响任务。</p>}
        </div>
      )}
    </section>
  );
}
