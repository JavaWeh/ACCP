import { Card, Chip } from "@heroui/react";
import { useEffect, useState } from "react";
import { ApiError, type API, type Doc } from "./api";
import { normalizeRepository, type GitProvider } from "./gitProviders";
import { useI18n } from "./i18n";
import {
  Button,
  Empty,
  Field,
  Form,
  Input,
  Message,
  Modal,
  Select,
  TextArea,
  text,
} from "./ui";

type ProbeState = {
  busy?: boolean;
  ok?: boolean;
  digest?: string;
  revision?: string;
  code?: string;
  error?: boolean;
};

type ProbeResult = {
  ok: boolean;
  content_digest?: string;
  revision?: string;
  code?: string;
};

const providerLabel: Record<string, string> = {
  github: "GitHub",
  gitlab: "GitLab",
};

export function RepositoriesPanel({
  api,
  project,
  reload,
}: {
  api: API;
  project: Doc;
  reload: () => Promise<void>;
}) {
  const { translate } = useI18n();
  const [repositories, setRepositories] = useState<Doc[]>([]);
  const [error, setError] = useState<unknown>();
  const [status, setStatus] = useState("");
  const [registering, setRegistering] = useState(false);
  const [provider, setProvider] = useState<GitProvider>("github");
  const [urlError, setUrlError] = useState("");
  const [existsError, setExistsError] = useState(false);
  const [probe, setProbe] = useState<Record<string, ProbeState>>({});

  async function refresh() {
    setRepositories(await api.all(`/projects/${project.id}/repositories`));
  }

  useEffect(() => {
    let live = true;
    refresh().catch((e) => {
      if (live) setError(e);
    });
    return () => {
      live = false;
    };
  }, [api, project.id]);

  function closeModal() {
    setRegistering(false);
    setUrlError("");
    setExistsError(false);
    setProvider("github");
  }

  async function testPull(repo: Doc) {
    setProbe((p) => ({ ...p, [repo.id]: { busy: true } }));
    try {
      const result = await api.call<ProbeResult>(
        `/projects/${project.id}/repositories/${repo.id}/test-pull`,
        {},
      );
      setProbe((p) => ({
        ...p,
        [repo.id]: result.ok
          ? {
              ok: true,
              digest: result.content_digest,
              revision: result.revision,
            }
          : { ok: false, code: result.code },
      }));
    } catch {
      setProbe((p) => ({ ...p, [repo.id]: { error: true } }));
    }
  }

  function probeMessage(code: string | undefined) {
    if (code === "AUTH") return translate("试拉失败：鉴权失败");
    if (code === "NOT_FOUND") return translate("试拉失败：仓库或路径未找到");
    return translate("试拉失败：网络错误");
  }

  if (project.status === "ARCHIVED") {
    return (
      <Empty title={translate("项目已归档，只读")}>
        {translate("此项目还没有登记仓库")}
      </Empty>
    );
  }

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
      <div className="mb-4 flex justify-end">
        <Button onPress={() => setRegistering(true)}>
          {translate("＋ 登记仓库")}
        </Button>
      </div>
      <Card className="panel space-y-3 p-6">
        {repositories.length === 0 ? (
          <div className="text-sm text-slate-600">
            <p>{translate("此项目还没有登记仓库")}</p>
            <p className="text-slate-500">
              {translate("可登记 GitHub 或 GitLab 仓库。")}
            </p>
          </div>
        ) : (
          repositories.map((repo) => {
            const state = probe[repo.id];
            return (
              <div
                key={repo.id}
                className="border-b border-slate-100 pb-3 last:border-0"
              >
                <div className="flex items-center gap-2">
                  <Chip size="sm" variant="soft">
                    {providerLabel[String(repo.provider_id)] ??
                      String(repo.provider_id)}
                  </Chip>
                  <strong className="break-all">
                    {repo.display_name || repo.url}
                  </strong>
                </div>
                {repo.display_name && (
                  <p className="text-sm text-slate-500 break-all">{repo.url}</p>
                )}
                <p className="text-sm text-slate-600">
                  {translate("默认分支")}: {repo.default_branch}
                </p>
                <div className="mt-2">
                  <Button
                    variant="tertiary"
                    size="sm"
                    isDisabled={state?.busy}
                    onPress={() => testPull(repo)}
                  >
                    {translate("试拉（只读）")}
                  </Button>
                </div>
                {state?.busy && (
                  <p
                    role="status"
                    aria-live="polite"
                    className="mt-2 text-sm text-slate-600"
                  >
                    {translate("试拉中…")}
                  </p>
                )}
                {state?.ok && (
                  <div
                    role="status"
                    aria-live="polite"
                    className="mt-2 rounded border border-emerald-200 bg-emerald-50 p-2 text-sm text-emerald-800"
                  >
                    <strong>{translate("试拉成功")}</strong>
                    <p className="break-all">
                      {translate("内容摘要")}: {state.digest}
                    </p>
                    <p className="break-all">
                      {translate("修订")}: {state.revision}
                    </p>
                  </div>
                )}
                {state && state.ok === false && !state.error && (
                  <p
                    role="alert"
                    className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-sm text-amber-800"
                  >
                    {probeMessage(state.code)}
                  </p>
                )}
                {state?.error && (
                  <p
                    role="alert"
                    className="mt-2 rounded border border-rose-200 bg-rose-50 p-2 text-sm text-rose-800"
                  >
                    {translate("试拉出错，请重试")}
                  </p>
                )}
              </div>
            );
          })
        )}
      </Card>
      {registering && (
        <Modal title={translate("登记仓库")} close={closeModal}>
          {existsError && (
            <Message
              error={
                new ApiError(
                  409,
                  "REPOSITORY_EXISTS",
                  translate("该仓库已登记"),
                  "local",
                )
              }
            />
          )}
          <Form
            submit={translate("登记仓库")}
            onDone={() => undefined}
            action={async (data) => {
              setExistsError(false);
              const normalized = normalizeRepository(
                provider,
                text(data, "url"),
              );
              if (!normalized) {
                setUrlError(translate("仓库地址格式不正确"));
                return { keepOpen: true };
              }
              const token = text(data, "access_token").trim();
              if (provider === "gitlab" && !token) {
                setUrlError("");
                return { keepOpen: true };
              }
              setUrlError("");
              try {
                await api.call(`/projects/${project.id}/repositories`, {
                  provider_id: provider,
                  url: normalized,
                  default_branch: text(data, "default_branch") || "main",
                  display_name: text(data, "display_name") || undefined,
                  access_token:
                    provider === "gitlab" && token ? token : undefined,
                  reason: text(data, "reason"),
                });
                closeModal();
                setStatus(translate("已登记仓库 {url}", { url: normalized }));
                await refresh();
                await reload();
              } catch (err) {
                if (
                  err instanceof ApiError &&
                  err.code === "REPOSITORY_EXISTS"
                ) {
                  setExistsError(true);
                  return { keepOpen: true };
                }
                if (
                  err instanceof ApiError &&
                  (err.code === "INVALID_REPOSITORY" ||
                    err.code === "ACCESS_TOKEN_REQUIRED")
                ) {
                  setUrlError(translate("仓库地址格式不正确"));
                  return { keepOpen: true };
                }
                throw err;
              }
            }}
          >
            <Field label={translate("提供方")}>
              <Select
                aria-label={translate("提供方")}
                value={provider}
                onChange={(value) => {
                  setProvider(value as GitProvider);
                  setUrlError("");
                }}
              >
                <option value="github">GitHub</option>
                <option value="gitlab">GitLab</option>
              </Select>
            </Field>
            <Field
              label={translate("仓库地址")}
              hint={
                provider === "gitlab"
                  ? translate("支持完整 HTTPS 地址或 group/project 短路径")
                  : translate("支持 owner/repo 或完整 GitHub 地址")
              }
              error={urlError || undefined}
            >
              <Input
                name="url"
                required
                autoFocus
                placeholder={
                  provider === "gitlab" ? "group/project" : "owner/repo"
                }
                isInvalid={!!urlError}
                onChange={() => setUrlError("")}
              />
            </Field>
            {provider === "gitlab" && (
              <Field
                label={translate("访问令牌（只读）")}
                hint={translate("仅 GitLab 需要；不回显已保存的令牌")}
              >
                <Input
                  name="access_token"
                  type="password"
                  autoComplete="off"
                  required
                  placeholder="glpat-…"
                />
              </Field>
            )}
            <Field label={translate("显示名称（可选）")}>
              <Input name="display_name" />
            </Field>
            <Field label={translate("默认分支")}>
              <Input name="default_branch" defaultValue="main" />
            </Field>
            <Field label={translate("操作原因")}>
              <TextArea name="reason" required />
            </Field>
            <div className="mb-2">
              <Button type="button" variant="tertiary" onPress={closeModal}>
                {translate("取消")}
              </Button>
            </div>
          </Form>
        </Modal>
      )}
    </>
  );
}
