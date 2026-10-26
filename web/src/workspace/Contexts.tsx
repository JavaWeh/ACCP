import { useI18n } from "../i18n";
import { Icon } from "../icons";
import { useEffect, useState } from "react";
import type { Workspace } from "../main";
import type { Doc } from "../api";
import { lineDiff } from "../diff";
import {
  Button,
  Input,
  Select,
  TextArea,
  Action,
  Badge,
  Empty,
  Field,
  Form,
  Message,
  Modal,
  text,
} from "../ui";
import { reviewer } from "./reviewer";
import { ContextCreateModal } from "./ContextCreateModal";

export function Contexts({ w }: { w: Workspace }) {
  const { translate, label } = useI18n();

  const [selected, setSelected] = useState<Doc>();
  const [creating, setCreating] = useState(false);
  const [sourceMode, setSourceMode] = useState("ACCP");
  const [gitRepositories, setGitRepositories] = useState<Doc[]>([]);
  const [versions, setVersions] = useState<Doc[]>([]);
  const [body, setBody] = useState("");
  const [comparison, setComparison] = useState<Doc>();
  const [reviewedVersion, setReviewedVersion] = useState("");
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    w.api
      .all(`/projects/${w.project.id}/repositories`)
      .then(setGitRepositories)
      .catch(setError);
  }, [w.api, w.project.id]);
  async function open(c: Doc) {
    setSelected(c);
    setBody("");
    setComparison(undefined);
    setReviewedVersion("");
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
  async function createGit(data: FormData) {
    const repository = gitRepositories.find(
      (repo) => repo.id === text(data, "repository"),
    );
    const path = text(data, "path").trim();
    if (
      !repository ||
      !path ||
      path.startsWith("/") ||
      path.split("/").some((part) => !part || part === "." || part === "..")
    ) {
      throw new Error(
        "Select a registered repository and a relative document path.",
      );
    }
    const context = await w.api.call(`/projects/${w.project.id}/contexts`, {
      name: text(data, "name"),
      type: text(data, "type"),
      source: {
        kind: "GIT",
        canonical_uri: `${repository.url}/blob/${repository.default_branch}/${path}`,
      },
    });
    await w.refresh();
    await open(context);
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
  const diff = comparison
    ? lineDiff(comparison.before_content, comparison.after_content)
    : undefined;
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
        <ContextCreateModal
          close={() => setCreating(false)}
          sourceMode={sourceMode}
          setSourceMode={setSourceMode}
          gitRepositories={gitRepositories}
          createGit={createGit}
          save={save}
          fields={fields}
        />
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
                {v.source_permalink && (
                  <small>
                    <a
                      href={v.source_permalink}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {translate("查看 Git 原文")}
                    </a>
                  </small>
                )}
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
              {v.status === "CANDIDATE" && (
                <Action
                  run={async () => {
                    setComparison(
                      await w.api.call(
                        `/contexts/${selected.id}/versions/${v.id}/comparison`,
                      ),
                    );
                    setReviewedVersion(v.id);
                  }}
                >
                  {translate("查看差异与影响")}
                </Action>
              )}
            </div>
          ))}
          {body && (
            <pre className="my-4 max-h-96 overflow-auto rounded-lg border border-slate-200 bg-slate-50 p-5 text-sm leading-7 whitespace-pre-wrap break-words">
              {body}
            </pre>
          )}
          {comparison && (
            <section className="my-4 rounded-lg border border-slate-200 p-4">
              <h3>{translate("版本差异与任务影响")}</h3>
              <p className="text-sm text-slate-600">
                {translate("仍使用旧版本的进行中任务：{count}", {
                  count: comparison.affected_task_count,
                })}
                。
                {translate(
                  "发布不会改变已有任务或执行快照；负责人需显式更新任务输入。",
                )}
              </p>
              {comparison.affected_tasks.map((task: Doc) => (
                <p key={task.id} className="text-sm">
                  {task.title} · {task.status}
                </p>
              ))}
              {diff && (
                <pre className="my-4 max-h-72 overflow-auto rounded border border-slate-200 bg-white p-3 text-xs leading-5">
                  {diff.map((line, index) => (
                    <span
                      key={index}
                      className={
                        line.kind === "add"
                          ? "block bg-emerald-50 text-emerald-800"
                          : line.kind === "remove"
                            ? "block bg-rose-50 text-rose-800"
                            : "block text-slate-500"
                      }
                    >
                      {line.kind === "add"
                        ? "+ "
                        : line.kind === "remove"
                          ? "− "
                          : "  "}
                      {line.text}
                    </span>
                  ))}
                </pre>
              )}
              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <strong>{translate("当前发布内容")}</strong>
                  <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-3 text-xs">
                    {comparison.before_content || "—"}
                  </pre>
                </div>
                <div>
                  <strong>{translate("候选内容")}</strong>
                  <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-3 text-xs">
                    {comparison.after_content}
                  </pre>
                </div>
              </div>
              {reviewer(w) &&
                versions.some(
                  (version) =>
                    version.id === reviewedVersion &&
                    version.status === "CANDIDATE",
                ) && (
                  <Form
                    submit={translate("确认差异并发布版本")}
                    action={async (data) => {
                      const version = versions.find(
                        (item) => item.id === reviewedVersion,
                      )!;
                      await w.api.call(
                        `/contexts/${selected.id}/versions/${version.id}/publish-reviewed`,
                        { reason: text(data, "reason") },
                        version.version,
                      );
                      await w.refresh();
                      await open(await w.api.call(`/contexts/${selected.id}`));
                    }}
                  >
                    <Field label={translate("发布审核理由")}>
                      <Input name="reason" required />
                    </Field>
                  </Form>
                )}
            </section>
          )}
          {selected.source.kind === "GIT" ? (
            <details>
              <summary>{translate("从 Git Commit 同步候选版本")}</summary>
              <Form
                submit={translate("同步 Git 文件")}
                action={async (data) => {
                  const current = await w.api.call(`/contexts/${selected.id}`);
                  await w.api.call(
                    `/contexts/${selected.id}/sync-git`,
                    {
                      source_revision: text(data, "revision"),
                      change_summary: text(data, "summary"),
                    },
                    current.version,
                  );
                  await w.refresh();
                  await open(await w.api.call(`/contexts/${selected.id}`));
                }}
              >
                <p className="break-all text-xs text-slate-600">
                  {selected.source.canonical_uri}
                </p>
                <Field label={translate("完整 Commit SHA")}>
                  <Input
                    name="revision"
                    required
                    minLength={40}
                    maxLength={40}
                  />
                </Field>
                <Field label={translate("变更说明")}>
                  <Input name="summary" required />
                </Field>
              </Form>
            </details>
          ) : (
            <details>
              <summary>{translate("新增候选版本")}</summary>
              <Form
                submit={translate("保存新版本")}
                action={(data) => save(data, selected)}
              >
                {fields}
              </Form>
            </details>
          )}
        </Modal>
      )}
    </>
  );
}
