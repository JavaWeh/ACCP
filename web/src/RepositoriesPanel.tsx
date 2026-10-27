import { Card } from "@heroui/react";
import { useEffect, useState } from "react";
import { ApiError, type API, type Doc } from "./api";
import { normalizeRepositoryUrl } from "./archiveBlockers";
import { useI18n } from "./i18n";
import {
  Button,
  Empty,
  Field,
  Form,
  Input,
  Message,
  Modal,
  TextArea,
  text,
} from "./ui";

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
  const [urlError, setUrlError] = useState("");
  const [existsError, setExistsError] = useState(false);

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
          <p className="text-sm text-slate-600">
            {translate("此项目还没有登记仓库")}
          </p>
        ) : (
          repositories.map((repo) => (
            <div
              key={repo.id}
              className="border-b border-slate-100 pb-3 last:border-0"
            >
              <strong className="break-all">{repo.url}</strong>
              <p className="text-sm text-slate-600">
                {translate("默认分支")}: {repo.default_branch}
              </p>
            </div>
          ))
        )}
      </Card>
      {registering && (
        <Modal
          title={translate("登记仓库")}
          close={() => {
            setRegistering(false);
            setUrlError("");
            setExistsError(false);
          }}
        >
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
              const normalized = normalizeRepositoryUrl(text(data, "url"));
              if (!normalized) {
                setUrlError(translate("仓库地址格式不正确"));
                return { keepOpen: true };
              }
              setUrlError("");
              try {
                await api.call(`/projects/${project.id}/repositories`, {
                  url: normalized,
                  default_branch: text(data, "default_branch") || "main",
                  reason: text(data, "reason"),
                });
                setRegistering(false);
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
                  err.code === "INVALID_REPOSITORY"
                ) {
                  setUrlError(translate("仓库地址格式不正确"));
                  return { keepOpen: true };
                }
                throw err;
              }
            }}
          >
            <Field
              label={translate("仓库地址")}
              hint={translate("支持 owner/repo 或完整 GitHub 地址")}
              error={urlError || undefined}
            >
              <Input
                name="url"
                required
                autoFocus
                placeholder="owner/repo"
                isInvalid={!!urlError}
                onChange={() => setUrlError("")}
              />
            </Field>
            <Field label={translate("默认分支")}>
              <Input name="default_branch" defaultValue="main" />
            </Field>
            <Field label={translate("操作原因")}>
              <TextArea name="reason" required />
            </Field>
            <div className="mb-2">
              <Button
                type="button"
                variant="tertiary"
                onPress={() => {
                  setRegistering(false);
                  setUrlError("");
                  setExistsError(false);
                }}
              >
                {translate("取消")}
              </Button>
            </div>
          </Form>
        </Modal>
      )}
    </>
  );
}
