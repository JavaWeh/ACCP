import { useEffect, useState } from "react";
import { API, type Doc } from "./api";
import { useI18n } from "./i18n";
import { Button, Field, Form, Input, Message, Empty, Json, text } from "./ui";
import { OrgAccounts } from "./OrgAccounts";
import { ForbiddenPage } from "./app/LinkStatus";
import { ProjectsPanel } from "./ProjectsPanel";
import { RepositoriesPanel } from "./RepositoriesPanel";

type Tab = "settings" | "org-accounts" | "projects" | "repositories";

function readManagementTab(
  isOrgAdmin: boolean,
  canSettings: boolean,
  canProjects: boolean,
  canRepos: boolean,
): Tab {
  const tab = new URLSearchParams(location.search).get("tab");
  if (tab === "org-accounts") return "org-accounts";
  if (tab === "projects" && canProjects) return "projects";
  if (tab === "repositories" && canRepos) return "repositories";
  if (tab === "settings" && canSettings) return "settings";
  if (canProjects && !canSettings) return "projects";
  if (canSettings) return "settings";
  return isOrgAdmin ? "org-accounts" : "settings";
}

function tabQuery(tab: Tab) {
  if (tab === "settings") return null;
  return tab;
}

export function Management({
  api,
  me,
  projects,
  projectID,
  reload,
}: {
  api: API;
  me: Doc;
  projects: Doc[];
  projectID: string;
  reload: (id?: string) => Promise<void>;
}) {
  const { translate: t, label } = useI18n();
  const [people, setPeople] = useState<Doc[]>([]),
    [audit, setAudit] = useState<Doc[]>([]),
    [config, setConfig] = useState<{ issuer: string; mode: string }>();
  const [error, setError] = useState<unknown>();
  const project = projects.find((p) => p.id === projectID);
  const administrator = projects.some((p) => p.roles?.includes("ADMIN"));
  const isOrgAdmin = me.is_org_admin === true;
  const canOpen = administrator || isOrgAdmin;
  const canProjects = administrator || isOrgAdmin;
  const projectAdmin = !!project?.roles?.includes("ADMIN");
  const active = project?.status !== "ARCHIVED";
  const [tab, setTab] = useState<Tab>(() =>
    readManagementTab(isOrgAdmin, administrator, canProjects, projectAdmin),
  );

  function selectTab(next: Tab, replace = false) {
    const url = new URL(location.href);
    const query = tabQuery(next);
    if (query) url.searchParams.set("tab", query);
    else url.searchParams.delete("tab");
    const href = url.pathname + url.search + url.hash;
    if (replace) history.replaceState(null, "", href);
    else history.pushState(null, "", href);
    setTab(next);
  }

  useEffect(() => {
    const onPop = () =>
      setTab(
        readManagementTab(isOrgAdmin, administrator, canProjects, projectAdmin),
      );
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, [isOrgAdmin, administrator, canProjects, projectAdmin]);

  useEffect(() => {
    const wanted = readManagementTab(
      isOrgAdmin,
      administrator,
      canProjects,
      projectAdmin,
    );
    if (wanted !== tab) setTab(wanted);
  }, [isOrgAdmin, administrator, canProjects, projectAdmin]);

  async function refresh() {
    if (!administrator && !isOrgAdmin) return;
    if (administrator) {
      const [members, records] = await Promise.all([
        api.all("/organization/members"),
        api.all("/organization/audit-records"),
      ]);
      setPeople(members);
      setAudit(records);
    }
  }
  useEffect(() => {
    let live = true;
    refresh().catch((e) => {
      if (live) setError(e);
    });
    fetch("/api/v1/auth/config")
      .then((r) => r.json())
      .then((c) => {
        if (live) setConfig(c);
      })
      .catch((e) => {
        if (live) setError(e);
      });
    return () => {
      live = false;
    };
  }, [api, projectID, administrator, isOrgAdmin]);
  async function done(id?: string) {
    await reload(id);
    await refresh();
  }
  if (!canOpen) return <Empty title={t("需要项目管理员权限")} />;
  if (tab === "org-accounts" && !isOrgAdmin) {
    return <ForbiddenPage detail={t("账号级停用仅组织管理员可操作。")} />;
  }
  if (tab === "repositories" && !projectAdmin) {
    return <ForbiddenPage />;
  }

  const reason = (
    <Field label={t("操作原因")}>
      <Input name="reason" required maxLength={2000} />
    </Field>
  );

  const tabs: { id: Tab; label: string; show: boolean }[] = [
    { id: "settings", label: t("设置"), show: administrator },
    { id: "projects", label: t("项目"), show: canProjects },
    { id: "repositories", label: t("仓库"), show: projectAdmin },
    { id: "org-accounts", label: t("组织账号"), show: isOrgAdmin },
  ];

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap gap-2 overflow-x-auto">
        {tabs
          .filter((item) => item.show)
          .map((item) => (
            <Button
              key={item.id}
              variant={tab === item.id ? "outline" : "ghost"}
              aria-current={tab === item.id ? "page" : undefined}
              onPress={() => selectTab(item.id)}
            >
              {item.label}
            </Button>
          ))}
      </div>
      {error !== undefined && <Message error={error} />}
      {tab === "org-accounts" ? (
        <OrgAccounts api={api} me={me} />
      ) : tab === "projects" ? (
        <ProjectsPanel
          api={api}
          projects={projects}
          canCreate={canProjects}
          reload={done}
        />
      ) : tab === "repositories" && project ? (
        <RepositoriesPanel
          api={api}
          project={project}
          reload={async () => {
            await done();
          }}
        />
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          <section className="rounded-xl border bg-white p-6">
            <h2>{t("登记企业成员")}</h2>
            <p>{t("登记身份不会自动授予项目访问权。")}</p>
            <Form
              submit={t("登记企业成员")}
              action={async (d) => {
                await api.call("/organization/members", {
                  issuer:
                    config?.mode === "development"
                      ? "urn:accp:development"
                      : config?.issuer,
                  subject: text(d, "subject"),
                  display_name: text(d, "display_name"),
                  reason: text(d, "reason"),
                });
                await done();
              }}
            >
              <Field label={t("身份主体标识")}>
                <Input name="subject" required maxLength={255} />
              </Field>
              <Field label={t("显示名称")}>
                <Input name="display_name" required maxLength={200} />
              </Field>
              {reason}
            </Form>
          </section>
          {projectAdmin && project && (
            <>
              <section className="rounded-xl border bg-white p-6">
                <h2>{t("项目设置")}</h2>
                <p>
                  {project.name} · {active ? t("使用中") : t("已归档")}
                </p>
                {active && (
                  <Form
                    key={project.id + String(project.version)}
                    submit={t("保存")}
                    action={async (d) => {
                      await api.call(
                        `/projects/${project.id}/changes`,
                        { name: text(d, "name"), reason: text(d, "reason") },
                        project.version,
                      );
                      await done();
                    }}
                  >
                    <Field label={t("项目名称")}>
                      <Input
                        name="name"
                        defaultValue={project.name}
                        required
                        maxLength={200}
                      />
                    </Field>
                    {reason}
                  </Form>
                )}
                {!active && (
                  <p className="mt-2 text-sm text-slate-600">
                    {t("项目已归档，只读")}
                  </p>
                )}
              </section>
              {active && (
                <section className="rounded-xl border bg-white p-6">
                  <h2>{t("添加项目成员")}</h2>
                  <Form
                    submit={t("添加项目成员")}
                    action={async (d) => {
                      await api.call(`/projects/${project.id}/members`, {
                        user_id: text(d, "user_id"),
                        roles: d.getAll("roles"),
                        reason: text(d, "reason"),
                      });
                      await done();
                    }}
                  >
                    <label>
                      {t("企业成员")}
                      <select
                        name="user_id"
                        required
                        className="block w-full rounded border p-2"
                      >
                        <option value="">{t("请选择")}</option>
                        {people
                          .filter((p) => p.active)
                          .map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.display_name} · {p.id}
                            </option>
                          ))}
                      </select>
                    </label>
                    <fieldset>
                      <legend>{t("项目角色")}</legend>
                      {["MEMBER", "REVIEWER", "VIEWER", "ADMIN"].map((role) => (
                        <label key={role} className="mr-4">
                          <input
                            type="checkbox"
                            name="roles"
                            value={role}
                            defaultChecked={role === "MEMBER"}
                          />
                          {label(role)}
                        </label>
                      ))}
                    </fieldset>
                    {reason}
                  </Form>
                </section>
              )}
            </>
          )}
          <section className="rounded-xl border bg-white p-6 lg:col-span-2">
            <h2>{t("企业管理审计")}</h2>
            <Json data={audit} />
          </section>
        </div>
      )}
    </div>
  );
}
