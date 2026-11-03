import { Card, Chip } from "@heroui/react";
import { useEffect, useState } from "react";
import { ApiError, type API, type Doc } from "./api";
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

// The three subscribable event types mirror the F3 notification taxonomy; the
// server maps TASK_BLOCKED to the internal TASK_FAILED event kind.
const EVENT_TYPES = ["REVIEW_REQUIRED", "APPROVAL_DECIDED", "TASK_BLOCKED"];

export function WebhooksPanel({
  api,
  project,
}: {
  api: API;
  project: Doc;
}) {
  const { translate, label } = useI18n();
  const [webhooks, setWebhooks] = useState<Doc[]>([]);
  const [error, setError] = useState<unknown>();
  const [status, setStatus] = useState("");
  const [creating, setCreating] = useState(false);
  const [urlError, setUrlError] = useState("");
  const [eventError, setEventError] = useState("");
  // The signing secret is echoed exactly once; hold it only in memory so the
  // operator can copy it before it disappears on the next render.
  const [secret, setSecret] = useState<{ url: string; value: string }>();
  const [busy, setBusy] = useState("");

  async function refresh() {
    setWebhooks(await api.all(`/projects/${project.id}/webhooks`));
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

  function urlErrorMessage(err: unknown) {
    if (err instanceof ApiError && err.code === "WEBHOOK_URL_REJECTED") {
      return translate("地址被拒绝：仅允许 HTTPS、允许列表内且非内网地址");
    }
    if (err instanceof ApiError && err.code === "WEBHOOK_SIGNING_UNAVAILABLE") {
      return translate("服务未配置签名密钥，无法创建 webhook");
    }
    return "";
  }

  async function act(
    path: string,
    body: Record<string, unknown>,
    version?: number,
  ) {
    setBusy(path);
    setError(undefined);
    try {
      return await api.call<Doc>(path, body, version);
    } catch (err) {
      setError(err);
      return undefined;
    } finally {
      setBusy("");
    }
  }

  async function toggle(hook: Doc) {
    const done = await act(
      `/projects/${project.id}/webhooks/${hook.id}/changes`,
      { enabled: !hook.enabled, reason: translate("启用或停用 webhook") },
      hook.version as number,
    );
    if (done) {
      setStatus(
        hook.enabled ? translate("已停用该 webhook") : translate("已启用该 webhook"),
      );
      await refresh();
    }
  }

  async function rotate(hook: Doc) {
    const done = await act(
      `/projects/${project.id}/webhooks/${hook.id}/rotate-secret`,
      {},
    );
    if (done?.signing_secret) {
      setSecret({ url: String(hook.url), value: String(done.signing_secret) });
      await refresh();
    }
  }

  async function remove(hook: Doc) {
    const done = await act(
      `/projects/${project.id}/webhooks/${hook.id}/delete`,
      {},
    );
    if (done) {
      setStatus(translate("已删除该 webhook"));
      await refresh();
    }
  }

  if (project.status === "ARCHIVED") {
    return (
      <Empty title={translate("项目已归档，只读")}>
        {translate("此项目还没有配置 webhook")}
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
      {secret && (
        <div
          role="status"
          aria-live="polite"
          className="mb-4 rounded border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900"
        >
          <strong>{translate("签名密钥（仅显示一次）")}</strong>
          <p className="mt-1 break-all font-mono">{secret.value}</p>
          <p className="mt-1 text-emerald-700">
            {translate("请立即复制保存；离开后将无法再次查看。")}
          </p>
          <div className="mt-2">
            <Button
              size="sm"
              variant="tertiary"
              onPress={() => setSecret(undefined)}
            >
              {translate("我已保存")}
            </Button>
          </div>
        </div>
      )}
      <div className="mb-4 flex justify-end">
        <Button onPress={() => setCreating(true)}>
          {translate("＋ 新建 webhook")}
        </Button>
      </div>
      <Card className="panel space-y-3 p-6">
        {webhooks.length === 0 ? (
          <div className="text-sm text-slate-600">
            <p>{translate("此项目还没有配置 webhook")}</p>
            <p className="text-slate-500">
              {translate(
                "可向允许列表内的 HTTPS 地址推送已签名、已脱敏的事件通知。",
              )}
            </p>
          </div>
        ) : (
          webhooks.map((hook) => (
            <div
              key={hook.id}
              className="border-b border-slate-100 pb-3 last:border-0"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Chip size="sm" variant={hook.enabled ? "soft" : "secondary"}>
                  {hook.enabled ? translate("已启用") : translate("已停用")}
                </Chip>
                <strong className="break-all">{String(hook.url)}</strong>
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                {(hook.event_types as string[]).map((type) => (
                  <Chip key={type} size="sm" variant="soft">
                    {label(type)}
                  </Chip>
                ))}
              </div>
              {hook.last_error_code ? (
                <p className="mt-1 text-sm text-amber-700">
                  {translate("最近投递")}: {String(hook.last_error_code)}
                  {hook.last_status ? ` (${String(hook.last_status)})` : ""}
                </p>
              ) : hook.last_status ? (
                <p className="mt-1 text-sm text-emerald-700">
                  {translate("最近投递")}: {String(hook.last_status)}
                </p>
              ) : (
                <p className="mt-1 text-sm text-slate-500">
                  {translate("尚无投递记录")}
                </p>
              )}
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  variant="tertiary"
                  size="sm"
                  isDisabled={!!busy}
                  onPress={() => toggle(hook)}
                >
                  {hook.enabled ? translate("停用") : translate("启用")}
                </Button>
                <Button
                  variant="tertiary"
                  size="sm"
                  isDisabled={!!busy}
                  onPress={() => rotate(hook)}
                >
                  {translate("轮换密钥")}
                </Button>
                <Button
                  variant="tertiary"
                  size="sm"
                  isDisabled={!!busy}
                  onPress={() => remove(hook)}
                >
                  {translate("删除")}
                </Button>
              </div>
            </div>
          ))
        )}
      </Card>
      {creating && (
        <Modal
          title={translate("新建 webhook")}
          close={() => {
            setCreating(false);
            setUrlError("");
            setEventError("");
          }}
        >
          <Form
            submit={translate("新建 webhook")}
            onDone={() => undefined}
            action={async (data) => {
              setUrlError("");
              setEventError("");
              const url = text(data, "url").trim();
              const eventTypes = data.getAll("event_types").map(String);
              if (eventTypes.length === 0) {
                setEventError(translate("请至少选择一个事件类型"));
                return { keepOpen: true };
              }
              try {
                const created = await api.call<Doc>(
                  `/projects/${project.id}/webhooks`,
                  {
                    url,
                    event_types: eventTypes,
                    reason: text(data, "reason"),
                  },
                );
                setCreating(false);
                if (created.signing_secret) {
                  setSecret({
                    url,
                    value: String(created.signing_secret),
                  });
                }
                setStatus(translate("已创建 webhook"));
                await refresh();
              } catch (err) {
                const message = urlErrorMessage(err);
                if (message) {
                  setUrlError(message);
                  return { keepOpen: true };
                }
                throw err;
              }
            }}
          >
            <Field
              label={translate("推送地址（HTTPS）")}
              hint={translate("主机需在运维配置的允许列表内")}
              error={urlError || undefined}
            >
              <Input
                name="url"
                required
                autoFocus
                placeholder="https://hooks.example.com/accp"
                isInvalid={!!urlError}
                onChange={() => setUrlError("")}
              />
            </Field>
            <fieldset>
              <legend>{translate("订阅事件")}</legend>
              {eventError && (
                <p role="alert" className="text-sm text-rose-700">
                  {eventError}
                </p>
              )}
              {EVENT_TYPES.map((type) => (
                <label key={type} className="mr-4">
                  <input type="checkbox" name="event_types" value={type} />
                  {label(type)}
                </label>
              ))}
            </fieldset>
            <Field label={translate("操作原因")}>
              <TextArea name="reason" required />
            </Field>
            <div className="mb-2">
              <Button
                type="button"
                variant="tertiary"
                onPress={() => {
                  setCreating(false);
                  setUrlError("");
                  setEventError("");
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
