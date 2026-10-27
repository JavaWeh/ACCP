import { Alert, Card, Chip, Table } from "@heroui/react";
import { useMemo, useState } from "react";
import { ApiError, type API, type Doc } from "./api";
import { parseArchiveBlockers, type ArchiveBlocker } from "./archiveBlockers";
import { useI18n } from "./i18n";
import type { MessageKey } from "./locales/zh-CN";
import {
  Button,
  Field,
  Form,
  Input,
  Message,
  Modal,
  Select,
  TextArea,
  text,
} from "./ui";

function kindLabel(kind: string, translate: (key: MessageKey) => string) {
  if (kind === "task") return translate("任务");
  if (kind === "run") return translate("执行 Run");
  if (kind === "invocation") return translate("工具操作");
  return kind;
}

export function ProjectsPanel({
  api,
  projects,
  canCreate,
  reload,
}: {
  api: API;
  projects: Doc[];
  canCreate: boolean;
  reload: (id?: string) => Promise<void>;
}) {
  const { translate } = useI18n();
  const [filter, setFilter] = useState("active");
  const [status, setStatus] = useState("");
  const [creating, setCreating] = useState(false);
  const [archiving, setArchiving] = useState<Doc>();
  const [restoring, setRestoring] = useState<Doc>();

  const filtered = useMemo(() => {
    return projects.filter((p) => {
      if (filter === "active") return p.status !== "ARCHIVED";
      if (filter === "archived") return p.status === "ARCHIVED";
      return true;
    });
  }, [projects, filter]);

  return (
    <>
      {status && (
        <p
          role="status"
          aria-live="polite"
          className="mb-4 text-sm text-slate-700"
        >
          {status}
        </p>
      )}
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <Field label={translate("状态")}>
          <Select
            aria-label={translate("状态")}
            value={filter}
            onChange={setFilter}
          >
            <option value="active">{translate("进行中")}</option>
            <option value="archived">{translate("已归档")}</option>
            <option value="all">{translate("全部")}</option>
          </Select>
        </Field>
        {canCreate && (
          <Button onPress={() => setCreating(true)}>
            {translate("＋ 创建项目")}
          </Button>
        )}
      </div>
      {filtered.length === 0 ? (
        <EmptyProjects
          canCreate={canCreate}
          onCreate={() => setCreating(true)}
        />
      ) : (
        <Card className="panel table-wrap">
          <Table>
            <Table.ScrollContainer>
              <Table.Content aria-label={translate("项目")}>
                <Table.Header>
                  <Table.Column isRowHeader>
                    {translate("项目名称")}
                  </Table.Column>
                  <Table.Column>{translate("状态")}</Table.Column>
                  <Table.Column>{translate("操作")}</Table.Column>
                </Table.Header>
                <Table.Body>
                  {filtered.map((project) => {
                    const archived = project.status === "ARCHIVED";
                    const projectAdmin = project.roles?.includes("ADMIN");
                    return (
                      <Table.Row key={project.id} id={project.id}>
                        <Table.Cell>
                          <strong>{project.name}</strong>
                          <div>
                            <small>{project.id}</small>
                          </div>
                        </Table.Cell>
                        <Table.Cell>
                          {archived ? (
                            <Chip color="warning" size="sm" variant="soft">
                              {translate("已归档")}
                            </Chip>
                          ) : (
                            <Chip color="success" size="sm" variant="soft">
                              {translate("使用中")}
                            </Chip>
                          )}
                        </Table.Cell>
                        <Table.Cell>
                          {projectAdmin && !archived && (
                            <Button
                              variant="danger-soft"
                              size="sm"
                              className="shrink-0 text-sm"
                              aria-label={translate("归档项目 {name}", {
                                name: project.name,
                              })}
                              onPress={() => setArchiving(project)}
                            >
                              {translate("归档项目")}
                            </Button>
                          )}
                          {projectAdmin && archived && (
                            <Button
                              size="sm"
                              className="shrink-0 text-sm"
                              aria-label={translate("恢复 {name}", {
                                name: project.name,
                              })}
                              onPress={() => setRestoring(project)}
                            >
                              {translate("恢复")}
                            </Button>
                          )}
                          {!projectAdmin && "—"}
                        </Table.Cell>
                      </Table.Row>
                    );
                  })}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>
          </Table>
        </Card>
      )}
      {creating && (
        <Modal title={translate("创建项目")} close={() => setCreating(false)}>
          <Form
            submit={translate("创建项目")}
            onDone={() => setCreating(false)}
            action={async (data) => {
              await api.call("/projects", {
                name: text(data, "name"),
                reason: text(data, "reason"),
              });
              setStatus(
                translate("已创建项目 {name}", {
                  name: text(data, "name"),
                }),
              );
              // Refresh list in place; navigating to the new id strips ?tab=.
              await reload();
            }}
          >
            <Field label={translate("项目名称")}>
              <Input name="name" required maxLength={200} autoFocus />
            </Field>
            <Field label={translate("操作原因")}>
              <TextArea name="reason" required />
            </Field>
            <div className="mb-2">
              <Button
                type="button"
                variant="tertiary"
                onPress={() => setCreating(false)}
              >
                {translate("取消")}
              </Button>
            </div>
          </Form>
        </Modal>
      )}
      {archiving && (
        <ArchiveProjectDialog
          api={api}
          project={archiving}
          close={() => setArchiving(undefined)}
          onDone={async (name) => {
            setArchiving(undefined);
            setStatus(translate("已归档项目 {name}", { name }));
            await reload();
          }}
        />
      )}
      {restoring && (
        <RestoreProjectDialog
          api={api}
          project={restoring}
          close={() => setRestoring(undefined)}
          onDone={async (name) => {
            setRestoring(undefined);
            setStatus(translate("已恢复项目 {name}", { name }));
            await reload();
          }}
        />
      )}
    </>
  );
}

function EmptyProjects({
  canCreate,
  onCreate,
}: {
  canCreate: boolean;
  onCreate: () => void;
}) {
  const { translate } = useI18n();
  return (
    <Card className="panel p-8 text-center">
      <p className="mb-4 text-slate-700">{translate("还没有项目")}</p>
      {canCreate && (
        <Button onPress={onCreate}>{translate("＋ 创建项目")}</Button>
      )}
    </Card>
  );
}

function ArchiveProjectDialog({
  api,
  project,
  close,
  onDone,
}: {
  api: API;
  project: Doc;
  close: () => void;
  onDone: (name: string) => Promise<void>;
}) {
  const { translate } = useI18n();
  const name = project.name || project.id;
  const [blockers, setBlockers] = useState<{
    blockers: ArchiveBlocker[];
    extra: number;
  }>();
  const [error, setError] = useState<unknown>();

  return (
    <Modal
      title={translate("归档项目 {name}？", { name })}
      close={close}
      dismissable={false}
      alertdialog
    >
      <p className="max-w-prose text-sm leading-6 text-slate-700">
        {translate("归档后项目变为只读，可在「已归档」中恢复。")}
      </p>
      {error !== undefined && <Message error={error} />}
      {blockers && blockers.blockers.length > 0 && (
        <>
          <Alert status="warning" className="my-4" role="alert">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>{translate("无法归档")}</Alert.Title>
              <Alert.Description>
                {translate("以下未完成工作会阻止归档：")}
              </Alert.Description>
            </Alert.Content>
          </Alert>
          <ul
            className="mb-4 list-disc space-y-1 pl-5 text-sm"
            tabIndex={-1}
            id="archive-blockers"
          >
            {blockers.blockers.map((item) => {
              const label = `${kindLabel(item.kind, translate)} · ${item.id}`;
              if (item.kind === "task") {
                return (
                  <li key={`${item.kind}:${item.id}`}>
                    <a
                      className="text-indigo-700 underline"
                      href={`/projects/${encodeURIComponent(project.id)}/tasks/${encodeURIComponent(item.id)}`}
                    >
                      {label}
                    </a>
                  </li>
                );
              }
              return <li key={`${item.kind}:${item.id}`}>{label}</li>;
            })}
            {blockers.extra > 0 && (
              <li>
                {translate("以及其他 {count} 项", { count: blockers.extra })}
              </li>
            )}
          </ul>
        </>
      )}
      <Form
        submit={translate("归档项目")}
        onDone={() => undefined}
        action={async (data) => {
          try {
            await api.call(
              `/projects/${project.id}/commands`,
              {
                command: "ARCHIVE",
                reason: text(data, "reason"),
              },
              project.version,
            );
            await onDone(name);
          } catch (err) {
            if (err instanceof ApiError && err.code === "ARCHIVE_BLOCKED") {
              setBlockers(parseArchiveBlockers(err.message));
              setError(undefined);
              queueMicrotask(() =>
                document.getElementById("archive-blockers")?.focus(),
              );
              return { keepOpen: true };
            }
            setError(err);
            return { keepOpen: true };
          }
        }}
      >
        <Field label={translate("操作原因")}>
          <TextArea
            name="reason"
            required
            autoFocus
            disabled={!!blockers?.blockers.length}
          />
        </Field>
        <div className="mb-2">
          <Button
            id="archive-project-cancel"
            type="button"
            variant="tertiary"
            onPress={close}
          >
            {translate("取消")}
          </Button>
        </div>
      </Form>
    </Modal>
  );
}

export function RestoreProjectDialog({
  api,
  project,
  close,
  onDone,
}: {
  api: API;
  project: Doc;
  close: () => void;
  onDone: (name: string) => Promise<void>;
}) {
  const { translate } = useI18n();
  const name = project.name || project.id;

  return (
    <Modal
      title={translate("恢复项目 {name}？", { name })}
      close={close}
      dismissable={false}
      alertdialog
    >
      <p className="max-w-prose text-sm leading-6 text-slate-700">
        {translate("恢复后项目重新可写，成员与数据保持归档前的状态。")}
      </p>
      <Form
        submit={translate("恢复项目")}
        onDone={() => undefined}
        action={async (data) => {
          await api.call(
            `/projects/${project.id}/commands`,
            {
              command: "RESTORE",
              reason: text(data, "reason"),
            },
            project.version,
          );
          await onDone(name);
        }}
      >
        <Field label={translate("操作原因")}>
          <TextArea name="reason" required autoFocus />
        </Field>
        <div className="mb-2">
          <Button type="button" variant="tertiary" onPress={close}>
            {translate("取消")}
          </Button>
        </div>
      </Form>
    </Modal>
  );
}
