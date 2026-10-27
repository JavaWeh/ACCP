import { useI18n } from "../i18n";
import { Alert, Card, Chip, Table } from "@heroui/react";
import { useEffect, useMemo, useState } from "react";
import type { Workspace } from "../main";
import { ApiError, type Doc, type Membership } from "../api";
import {
  Button,
  TextArea,
  Checkbox,
  Field,
  Form,
  Input,
  Modal,
  Message,
  Select,
  text,
} from "../ui";

function membershipActive(m: Membership) {
  return m.membership_active ?? m.active;
}
function accountActive(m: Membership) {
  return m.account_active !== false;
}

export function Members({ w }: { w: Workspace }) {
  const { translate, label } = useI18n();
  const isAdmin = w.roles.includes("ADMIN");
  const [selected, setSelected] = useState<Membership>();
  const [adding, setAdding] = useState(false);
  const [deactivating, setDeactivating] = useState<Membership>();
  const [people, setPeople] = useState<Doc[]>([]);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [status, setStatus] = useState("");
  const [addError, setAddError] = useState<unknown>();

  useEffect(() => {
    if (!adding || !isAdmin) return;
    let live = true;
    w.api
      .all<Doc>("/organization/members")
      .then((items) => {
        if (live) setPeople(items);
      })
      .catch((error) => {
        if (live) setAddError(error);
      });
    return () => {
      live = false;
    };
  }, [adding, isAdmin, w.api]);

  const memberIds = useMemo(
    () => new Set(w.members.map((m) => m.id)),
    [w.members],
  );
  const candidates = people.filter(
    (p) => p.active !== false && !memberIds.has(p.id),
  );
  const filtered = w.members.filter((m) => {
    const haystack = `${m.display_name || ""} ${m.id}`.toLowerCase();
    if (query && !haystack.includes(query.trim().toLowerCase())) return false;
    if (statusFilter === "active" && !membershipActive(m)) return false;
    if (statusFilter === "inactive" && membershipActive(m)) return false;
    return true;
  });

  return (
    <>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <p className="text-sm leading-6 text-slate-600">
          {translate("企业身份与项目角色共同决定访问权限。")}
        </p>
        {isAdmin && (
          <Button
            variant="primary"
            className="shrink-0"
            onPress={() => {
              setAddError(undefined);
              setAdding(true);
            }}
          >
            {translate("＋ 添加成员")}
          </Button>
        )}
      </div>
      {status && (
        <p
          role="status"
          aria-live="polite"
          className="mb-4 text-sm text-slate-700"
        >
          {status}
        </p>
      )}
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Field label={translate("搜索成员")}>
          <Input
            aria-label={translate("搜索成员")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={translate("搜索姓名或身份标识…")}
          />
        </Field>
        <Field label={translate("成员状态")}>
          <Select
            aria-label={translate("成员状态")}
            value={statusFilter}
            onChange={setStatusFilter}
          >
            <option value="all">{translate("全部")}</option>
            <option value="active">{translate("启用")}</option>
            <option value="inactive">{translate("已停用")}</option>
          </Select>
        </Field>
      </div>
      <Card className="panel table-wrap">
        <Table>
          <Table.ScrollContainer>
            <Table.Content aria-label={translate("项目成员")}>
              <Table.Header>
                <Table.Column isRowHeader>{translate("姓名")}</Table.Column>
                <Table.Column>{translate("身份标识")}</Table.Column>
                <Table.Column>{translate("项目角色")}</Table.Column>
                <Table.Column>{translate("成员状态")}</Table.Column>
                <Table.Column>{translate("账号")}</Table.Column>
                <Table.Column>{translate("操作")}</Table.Column>
              </Table.Header>
              <Table.Body>
                {filtered.map((m) => {
                  const canDeactivate =
                    isAdmin &&
                    membershipActive(m) &&
                    accountActive(m) &&
                    m.id !== w.me.id;
                  return (
                    <Table.Row key={m.id} id={m.id}>
                      <Table.Cell>
                        <strong>{m.display_name || m.id}</strong>
                      </Table.Cell>
                      <Table.Cell>
                        <small>{m.id}</small>
                      </Table.Cell>
                      <Table.Cell>{m.roles.map(label).join(" / ")}</Table.Cell>
                      <Table.Cell>
                        <Chip
                          color={membershipActive(m) ? "success" : "default"}
                          size="sm"
                          variant="soft"
                        >
                          {membershipActive(m)
                            ? translate("启用")
                            : translate("已停用")}
                        </Chip>
                      </Table.Cell>
                      <Table.Cell>
                        {accountActive(m) ? (
                          "—"
                        ) : (
                          <Chip color="danger" size="sm" variant="soft">
                            {translate("账号已停用")}
                          </Chip>
                        )}
                      </Table.Cell>
                      <Table.Cell>
                        <div className="flex flex-wrap gap-2">
                          {isAdmin && (
                            <Button
                              variant="ghost"
                              className="shrink-0 text-sm"
                              onPress={() => setSelected(m)}
                            >
                              {translate("管理角色")}
                            </Button>
                          )}
                          {canDeactivate && (
                            <Button
                              variant="danger-soft"
                              className="shrink-0 text-sm"
                              aria-label={translate("从本项目停用 {name}", {
                                name: m.display_name || m.id,
                              })}
                              onPress={() => setDeactivating(m)}
                            >
                              {translate("从本项目停用")}
                            </Button>
                          )}
                        </div>
                      </Table.Cell>
                    </Table.Row>
                  );
                })}
              </Table.Body>
            </Table.Content>
          </Table.ScrollContainer>
        </Table>
      </Card>
      {adding && (
        <Modal title={translate("添加成员")} close={() => setAdding(false)}>
          {addError !== undefined && <Message error={addError} />}
          <Form
            submit={translate("添加成员")}
            onDone={() => setAdding(false)}
            action={async (data) => {
              await w.api.call(`/projects/${w.project.id}/members`, {
                user_id: text(data, "user_id"),
                roles: data.getAll("roles"),
                reason: text(data, "reason"),
              });
              setStatus("");
              await w.refresh();
            }}
          >
            <Field label={translate("企业成员")}>
              <Select
                name="user_id"
                required
                aria-label={translate("企业成员")}
              >
                <option value="">{translate("请选择")}</option>
                {candidates.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.display_name || p.id} · {p.id}
                  </option>
                ))}
              </Select>
            </Field>
            <fieldset>
              <legend>{translate("项目角色")}</legend>
              {["MEMBER", "REVIEWER", "VIEWER", "ADMIN"].map((role) => (
                <Checkbox
                  key={role}
                  name="roles"
                  value={role}
                  defaultSelected={role === "MEMBER"}
                >
                  {label(role)}
                </Checkbox>
              ))}
            </fieldset>
            <Field label={translate("操作原因")}>
              <TextArea name="reason" required autoFocus />
            </Field>
          </Form>
        </Modal>
      )}
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
            <Checkbox
              name="active"
              defaultSelected={membershipActive(selected)}
            >
              {translate("启用成员访问")}
            </Checkbox>
            <Field label={translate("变更原因")}>
              <TextArea name="reason" required />
            </Field>
          </Form>
        </Modal>
      )}
      {deactivating && (
        <DeactivateMemberDialog
          w={w}
          member={deactivating}
          close={() => setDeactivating(undefined)}
          onDone={async (name) => {
            setDeactivating(undefined);
            setStatus(translate("已从本项目停用 {name}", { name }));
            await w.refresh();
          }}
        />
      )}
    </>
  );
}

function DeactivateMemberDialog({
  w,
  member,
  close,
  onDone,
}: {
  w: Workspace;
  member: Membership;
  close: () => void;
  onDone: (name: string) => Promise<void>;
}) {
  const { translate } = useI18n();
  const name = member.display_name || member.id;
  const [lastAdmin, setLastAdmin] = useState(false);

  return (
    <Modal
      title={translate("从本项目停用 {name}？", { name })}
      close={close}
      dismissable={false}
      alertdialog
    >
      <p className="max-w-prose text-sm leading-6 text-slate-700">
        {translate(
          "仅停用其在本项目的访问，并立即吊销其在本项目委托的 Agent 会话；不影响其在其他项目的成员身份；其已负责的任务不会自动转交。",
        )}
      </p>
      <Alert status="warning" className="my-4" role="status">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Title>
            {translate("如其名下有未完成任务，请先通过任务交接（D07）处理。")}
          </Alert.Title>
        </Alert.Content>
      </Alert>
      {lastAdmin && (
        <Alert status="danger" className="my-4" role="alert">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{translate("无法停用最后一名管理员")}</Alert.Title>
            <Alert.Description>
              {translate(
                "{name} 是本项目唯一的管理员。请先为其他成员授予管理员角色，再停用此成员。",
                { name },
              )}
            </Alert.Description>
          </Alert.Content>
        </Alert>
      )}
      <Form
        submit={translate("从本项目停用")}
        onDone={() => undefined}
        action={async (data) => {
          try {
            await w.api.call(
              `/projects/${w.project.id}/members/${member.id}/changes`,
              {
                roles: member.roles,
                active: false,
                reason: text(data, "reason"),
              },
              member.version,
            );
            await onDone(name);
          } catch (err) {
            if (err instanceof ApiError && err.code === "LAST_ADMIN") {
              setLastAdmin(true);
              queueMicrotask(() =>
                document.getElementById("deactivate-member-cancel")?.focus(),
              );
              return { keepOpen: true };
            }
            throw err;
          }
        }}
      >
        <Field label={translate("操作原因")}>
          <TextArea name="reason" required autoFocus disabled={lastAdmin} />
        </Field>
        <div className="mb-2">
          <Button
            id="deactivate-member-cancel"
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
