import { Alert, Card, Chip, Table } from "@heroui/react";
import { useEffect, useMemo, useState } from "react";
import { ApiError, type API, type Doc } from "./api";
import { useI18n } from "./i18n";
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

function accountActive(person: Doc) {
  return person.account_active !== false && person.active !== false;
}

export function OrgAccounts({ api, me }: { api: API; me: Doc }) {
  const { translate } = useI18n();
  const [people, setPeople] = useState<Doc[]>([]);
  const [error, setError] = useState<unknown>();
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [status, setStatus] = useState("");
  const [deactivating, setDeactivating] = useState<Doc>();
  const [reactivating, setReactivating] = useState<Doc>();
  const [adminChange, setAdminChange] = useState<Doc>();

  async function refresh() {
    setPeople(await api.all("/organization/members"));
  }

  useEffect(() => {
    let live = true;
    refresh().catch((e) => {
      if (live) setError(e);
    });
    return () => {
      live = false;
    };
  }, [api]);

  const filtered = useMemo(() => {
    return people.filter((p) => {
      const haystack = `${p.display_name || ""} ${p.id}`.toLowerCase();
      if (query && !haystack.includes(query.trim().toLowerCase())) return false;
      if (statusFilter === "active" && !accountActive(p)) return false;
      if (statusFilter === "inactive" && accountActive(p)) return false;
      return true;
    });
  }, [people, query, statusFilter]);

  return (
    <>
      {error !== undefined && <Message error={error} />}
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
        <Field label={translate("搜索姓名或邮箱")}>
          <Input
            aria-label={translate("搜索姓名或邮箱")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={translate("搜索姓名或身份标识…")}
          />
        </Field>
        <Field label={translate("状态")}>
          <Select
            aria-label={translate("状态")}
            value={statusFilter}
            onChange={setStatusFilter}
          >
            <option value="all">{translate("全部")}</option>
            <option value="active">{translate("启用")}</option>
            <option value="inactive">{translate("账号已停用")}</option>
          </Select>
        </Field>
      </div>
      <Card className="panel table-wrap">
        <Table>
          <Table.ScrollContainer>
            <Table.Content aria-label={translate("组织账号")}>
              <Table.Header>
                <Table.Column isRowHeader>{translate("姓名")}</Table.Column>
                <Table.Column>{translate("身份标识")}</Table.Column>
                <Table.Column>{translate("组织角色")}</Table.Column>
                <Table.Column>{translate("状态")}</Table.Column>
                <Table.Column>{translate("操作")}</Table.Column>
              </Table.Header>
              <Table.Body>
                {filtered.map((person) => {
                  const name = person.display_name || person.id;
                  const active = accountActive(person);
                  const self = person.id === me.id;
                  const isAdmin = person.is_org_admin === true;
                  return (
                    <Table.Row key={person.id} id={person.id}>
                      <Table.Cell>
                        <strong>{name}</strong>
                      </Table.Cell>
                      <Table.Cell>
                        <small>{person.id}</small>
                      </Table.Cell>
                      <Table.Cell>
                        {isAdmin ? (
                          <Chip color="accent" size="sm" variant="soft">
                            {translate("组织管理员")}
                          </Chip>
                        ) : (
                          "—"
                        )}
                      </Table.Cell>
                      <Table.Cell>
                        {active ? (
                          <Chip color="success" size="sm" variant="soft">
                            {translate("启用")}
                          </Chip>
                        ) : (
                          <Chip color="danger" size="sm" variant="soft">
                            {translate("账号已停用")}
                          </Chip>
                        )}
                      </Table.Cell>
                      <Table.Cell>
                        {active && !self && (
                          <div className="flex flex-wrap gap-2">
                            <Button
                              variant="danger-soft"
                              size="sm"
                              className="shrink-0 text-sm"
                              aria-label={translate("停用账号 {name}", {
                                name,
                              })}
                              onPress={() => setDeactivating(person)}
                            >
                              {translate("停用账号")}
                            </Button>
                            <Button
                              variant="tertiary"
                              size="sm"
                              className="shrink-0 text-sm"
                              aria-label={translate(
                                isAdmin
                                  ? "撤销组织管理员 {name}"
                                  : "授予组织管理员 {name}",
                                { name },
                              )}
                              onPress={() => setAdminChange(person)}
                            >
                              {translate(
                                isAdmin ? "撤销组织管理员" : "授予组织管理员",
                              )}
                            </Button>
                          </div>
                        )}
                        {!active && (
                          <Button
                            variant="secondary"
                            size="sm"
                            className="shrink-0 text-sm"
                            aria-label={translate("恢复账号 {name}", { name })}
                            onPress={() => setReactivating(person)}
                          >
                            {translate("恢复账号")}
                          </Button>
                        )}
                        {active && self && "—"}
                      </Table.Cell>
                    </Table.Row>
                  );
                })}
              </Table.Body>
            </Table.Content>
          </Table.ScrollContainer>
        </Table>
      </Card>
      {deactivating && (
        <DeactivateAccountDialog
          api={api}
          person={deactivating}
          close={() => setDeactivating(undefined)}
          onDone={async (name) => {
            setDeactivating(undefined);
            setStatus(translate("已停用账号 {name}", { name }));
            await refresh();
          }}
        />
      )}
      {reactivating && (
        <ReactivateAccountDialog
          api={api}
          person={reactivating}
          close={() => setReactivating(undefined)}
          onDone={async (name) => {
            setReactivating(undefined);
            setStatus(translate("已恢复账号 {name}", { name }));
            await refresh();
          }}
        />
      )}
      {adminChange && (
        <OrgAdminDialog
          api={api}
          person={adminChange}
          close={() => setAdminChange(undefined)}
          onDone={async (name, granted) => {
            setAdminChange(undefined);
            setStatus(
              granted
                ? translate("已授予组织管理员 {name}", { name })
                : translate("已撤销组织管理员 {name}", { name }),
            );
            await refresh();
          }}
        />
      )}
    </>
  );
}

function DeactivateAccountDialog({
  api,
  person,
  close,
  onDone,
}: {
  api: API;
  person: Doc;
  close: () => void;
  onDone: (name: string) => Promise<void>;
}) {
  const { translate } = useI18n();
  const name = person.display_name || person.id;
  const [lastOrgAdmin, setLastOrgAdmin] = useState(false);
  const [forbidden, setForbidden] = useState(false);

  return (
    <Modal
      title={translate("停用账号 {name}？", { name })}
      close={close}
      dismissable={false}
      alertdialog
    >
      <Alert status="warning" className="mb-4" role="status">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Title>{translate("这是账号级停用。")}</Alert.Title>
        </Alert.Content>
      </Alert>
      <p className="max-w-prose text-sm leading-6 text-slate-700">
        {translate(
          "停用后，{name} 将无法登录控制台，也无法调用 API；其在所有项目中的访问立即失效，并吊销其委托的 Agent/MCP 会话。此操作写入审计。",
          { name },
        )}
      </p>
      {forbidden && (
        <Alert status="danger" className="my-4" role="alert">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{translate("你没有组织管理员权限")}</Alert.Title>
          </Alert.Content>
        </Alert>
      )}
      {lastOrgAdmin && (
        <Alert status="danger" className="my-4" role="alert">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{translate("无法停用最后一名组织管理员")}</Alert.Title>
            <Alert.Description>
              {translate(
                "{name} 是唯一的组织管理员。请先将组织管理员授予他人，再停用此账号。",
                { name },
              )}
            </Alert.Description>
          </Alert.Content>
        </Alert>
      )}
      <Form
        submit={translate("停用账号")}
        onDone={() => undefined}
        action={async (data) => {
          try {
            await api.call(`/organization/members/${person.id}/changes`, {
              active: false,
              reason: text(data, "reason"),
            });
            await onDone(name);
          } catch (err) {
            if (err instanceof ApiError && err.code === "LAST_ORG_ADMIN") {
              setLastOrgAdmin(true);
              queueMicrotask(() =>
                document.getElementById("deactivate-account-cancel")?.focus(),
              );
              return { keepOpen: true };
            }
            if (
              err instanceof ApiError &&
              (err.status === 403 || err.code === "ORG_ADMIN_REQUIRED")
            ) {
              setForbidden(true);
              return { keepOpen: true };
            }
            throw err;
          }
        }}
      >
        <Field label={translate("操作原因")}>
          <TextArea
            name="reason"
            required
            autoFocus
            disabled={lastOrgAdmin || forbidden}
          />
        </Field>
        <div className="mb-2">
          <Button
            id="deactivate-account-cancel"
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

function ReactivateAccountDialog({
  api,
  person,
  close,
  onDone,
}: {
  api: API;
  person: Doc;
  close: () => void;
  onDone: (name: string) => Promise<void>;
}) {
  const { translate } = useI18n();
  const name = person.display_name || person.id;
  const [forbidden, setForbidden] = useState(false);

  return (
    <Modal
      title={translate("恢复账号 {name}？", { name })}
      close={close}
      dismissable={false}
      alertdialog
    >
      <p className="max-w-prose text-sm leading-6 text-slate-700">
        {translate(
          "恢复后，{name} 可以重新登录控制台并调用 API。项目成员身份保持停用前的状态，不会自动恢复；已吊销的 Agent/MCP 会话不会重新签发。此操作写入审计。",
          { name },
        )}
      </p>
      {forbidden && (
        <Alert status="danger" className="my-4" role="alert">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{translate("你没有组织管理员权限")}</Alert.Title>
          </Alert.Content>
        </Alert>
      )}
      <Form
        submit={translate("恢复账号")}
        onDone={() => undefined}
        action={async (data) => {
          try {
            await api.call(`/organization/members/${person.id}/changes`, {
              active: true,
              reason: text(data, "reason"),
            });
            await onDone(name);
          } catch (err) {
            if (
              err instanceof ApiError &&
              (err.status === 403 || err.code === "ORG_ADMIN_REQUIRED")
            ) {
              setForbidden(true);
              return { keepOpen: true };
            }
            throw err;
          }
        }}
      >
        <Field label={translate("操作原因")}>
          <TextArea name="reason" required autoFocus disabled={forbidden} />
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

function OrgAdminDialog({
  api,
  person,
  close,
  onDone,
}: {
  api: API;
  person: Doc;
  close: () => void;
  onDone: (name: string, granted: boolean) => Promise<void>;
}) {
  const { translate } = useI18n();
  const name = person.display_name || person.id;
  const granting = person.is_org_admin !== true;
  const [lastOrgAdmin, setLastOrgAdmin] = useState(false);
  const [forbidden, setForbidden] = useState(false);

  return (
    <Modal
      title={translate(
        granting ? "授予组织管理员：{name}？" : "撤销组织管理员：{name}？",
        { name },
      )}
      close={close}
      dismissable={false}
      alertdialog
    >
      <p className="max-w-prose text-sm leading-6 text-slate-700">
        {translate(
          granting
            ? "{name} 将获得组织管理员权限，可管理组织账号、授予或撤销组织管理员，并执行账号级停用与恢复。此操作写入审计。"
            : "撤销后，{name} 将不再拥有组织管理员权限，但其项目成员身份不受影响。此操作写入审计。",
          { name },
        )}
      </p>
      {forbidden && (
        <Alert status="danger" className="my-4" role="alert">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{translate("你没有组织管理员权限")}</Alert.Title>
          </Alert.Content>
        </Alert>
      )}
      {lastOrgAdmin && (
        <Alert status="danger" className="my-4" role="alert">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{translate("无法撤销最后一名组织管理员")}</Alert.Title>
            <Alert.Description>
              {translate(
                "{name} 是唯一的组织管理员。请先将组织管理员授予他人，再撤销其权限。",
                { name },
              )}
            </Alert.Description>
          </Alert.Content>
        </Alert>
      )}
      <Form
        submit={translate(granting ? "授予组织管理员" : "撤销组织管理员")}
        onDone={() => undefined}
        action={async (data) => {
          try {
            await api.call(`/organization/members/${person.id}/changes`, {
              is_org_admin: granting,
              reason: text(data, "reason"),
            });
            await onDone(name, granting);
          } catch (err) {
            if (err instanceof ApiError && err.code === "LAST_ORG_ADMIN") {
              setLastOrgAdmin(true);
              queueMicrotask(() =>
                document.getElementById("org-admin-cancel")?.focus(),
              );
              return { keepOpen: true };
            }
            if (
              err instanceof ApiError &&
              (err.status === 403 || err.code === "ORG_ADMIN_REQUIRED")
            ) {
              setForbidden(true);
              return { keepOpen: true };
            }
            throw err;
          }
        }}
      >
        <Field label={translate("操作原因")}>
          <TextArea
            name="reason"
            required
            autoFocus
            disabled={lastOrgAdmin || forbidden}
          />
        </Field>
        <div className="mb-2">
          <Button
            id="org-admin-cancel"
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
