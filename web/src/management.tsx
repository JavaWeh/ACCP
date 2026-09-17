import { useEffect, useState } from "react";
import { API, type Doc } from "./api";
import { useI18n } from "./i18n";
import { Field, Form, Input, Message, Empty, Json, text } from "./ui";

export function Management({
  api,
  projects,
  projectID,
  reload,
}: {
  api: API;
  projects: Doc[];
  projectID: string;
  reload: (id?: string) => Promise<void>;
}) {
  const { translate: t, label } = useI18n();
  const [people, setPeople] = useState<Doc[]>([]),
    [repositories, setRepositories] = useState<Doc[]>([]),
    [audit, setAudit] = useState<Doc[]>([]),
    [config, setConfig] = useState<{ issuer: string; mode: string }>();
  const [error, setError] = useState<unknown>();
  const project = projects.find((p) => p.id === projectID);
  const administrator = projects.some((p) => p.roles?.includes("ADMIN"));
  const projectAdmin = project?.roles?.includes("ADMIN"),
    active = project?.status !== "ARCHIVED";
  async function refresh() {
    if (!administrator) return;
    const [members, records] = await Promise.all([
      api.all("/organization/members"),
      api.all("/organization/audit-records"),
    ]);
    setPeople(members);
    setAudit(records);
    if (projectID)
      setRepositories(await api.all(`/projects/${projectID}/repositories`));
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
  }, [api, projectID, administrator]);
  async function done(id?: string) {
    await reload(id);
    await refresh();
  }
  if (!administrator) return <Empty title={t("需要项目管理员权限")} />;
  const reason = (
    <Field label={t("操作原因")}>
      <Input name="reason" required maxLength={2000} />
    </Field>
  );
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {error !== undefined && <Message error={error} />}
      <section className="rounded-xl border bg-white p-6">
        <h2>{t("创建项目")}</h2>
        <Form
          submit={t("创建项目")}
          action={async (d) => {
            const p = await api.call("/projects", {
              name: text(d, "name"),
              reason: text(d, "reason"),
            });
            await done(p.id);
          }}
        >
          <Field label={t("项目名称")}>
            <Input name="name" required maxLength={200} />
          </Field>
          {reason}
        </Form>
      </section>
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
            <Form
              submit={active ? t("归档项目") : t("恢复项目")}
              action={async (d) => {
                await api.call(
                  `/projects/${project.id}/commands`,
                  {
                    command: active ? "ARCHIVE" : "RESTORE",
                    reason: text(d, "reason"),
                  },
                  project.version,
                );
                await done();
              }}
            >
              <p>{t("归档前必须结束任务并核对所有未结操作。")}</p>
              {reason}
            </Form>
          </section>
          {active && (
            <>
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
              <section className="rounded-xl border bg-white p-6">
                <h2>{t("登记仓库")}</h2>
                <Form
                  submit={t("登记仓库")}
                  action={async (d) => {
                    await api.call(`/projects/${project.id}/repositories`, {
                      url: text(d, "url"),
                      default_branch: text(d, "default_branch"),
                      reason: text(d, "reason"),
                    });
                    await done();
                  }}
                >
                  <Field label={t("GitHub 仓库地址")}>
                    <Input
                      name="url"
                      type="url"
                      required
                      placeholder="https://github.com/owner/repository"
                    />
                  </Field>
                  <Field label={t("默认分支")}>
                    <Input name="default_branch" defaultValue="main" required />
                  </Field>
                  {reason}
                </Form>
                {repositories.length ? (
                  repositories.map((r) => (
                    <p key={r.id}>
                      {r.url} · {r.default_branch}
                    </p>
                  ))
                ) : (
                  <p>{t("请先登记仓库，再创建任务。")}</p>
                )}
              </section>
            </>
          )}
        </>
      )}
      <section className="rounded-xl border bg-white p-6 lg:col-span-2">
        <h2>{t("企业管理审计")}</h2>
        <Json data={audit} />
      </section>
    </div>
  );
}
