import { useI18n } from "../i18n";
import { Icon } from "../icons";
import { Card } from "@heroui/react";
import { useEffect, useState } from "react";
import type { Workspace } from "../main";
import type { Doc } from "../api";
import { short } from "../api";
import {
  Button,
  Input,
  Select,
  TextArea,
  Checkbox,
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

export function Tools({ w }: { w: Workspace }) {
  const { translate, label, stamp } = useI18n();

  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<Doc>();
  const [backends, setBackends] = useState<Doc[]>([]);
  const [invocations, setInvocations] = useState<Doc[]>([]);
  const [error, setError] = useState<unknown>();
  async function load() {
    if (w.roles.includes("ADMIN"))
      setBackends(
        (await w.api.call(`/projects/${w.project.id}/tool-backends`)).items,
      );
    if (reviewer(w))
      setInvocations(
        await w.api.all(`/projects/${w.project.id}/tool-invocations`),
      );
  }
  useEffect(() => {
    load().catch(setError);
  }, [w.api, w.project.id]);
  const fields = (
    <>
      <Field label={translate("已配置工具")}>
        <Select
          name="backend"
          defaultValue={selected?.backend_id}
          required
          disabled={!!selected}
        >
          {backends.map((b) => (
            <option key={b.id} value={b.id}>
              {b.id} · {label(b.risk)}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={translate("工具名称")}>
        <Input name="name" required defaultValue={selected?.name} />
      </Field>
      <Field
        label={translate("资源版本")}
        hint={translate("版本变化后，旧审批不能用于执行。")}
      >
        <Input
          name="revision"
          required
          defaultValue={selected?.resource_version || "1"}
        />
      </Field>
      <Checkbox
        name="enabled"
        defaultSelected={selected ? selected.enabled : true}
      >
        {translate("允许请求此工具")}
      </Checkbox>
      <Field label={translate("配置原因")}>
        <TextArea name="reason" required />
      </Field>
    </>
  );
  return (
    <>
      {error !== undefined && <Message error={error} />}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4 [&>p]:text-sm [&>p]:text-slate-600">
        <p className="text-sm leading-6 text-slate-600">
          {translate("工具风险由受信配置决定，调用经过权限检查与审批。")}
        </p>
        {w.roles.includes("ADMIN") && (
          <Button
            variant="primary"
            onClick={() => {
              setSelected(undefined);
              setCreating(true);
            }}
          >
            {translate("＋ 注册工具策略")}
          </Button>
        )}
      </div>
      {!w.tools.length ? (
        <Empty title={translate("尚未开放工具")}>
          {translate("管理员先配置下游工具端点与凭证，再为项目注册策略。")}
        </Empty>
      ) : (
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2 2xl:grid-cols-3">
          {w.tools.map((t) => (
            <Card className="context-card" key={t.id}>
              <div className="context-icon">
                <Icon name="tools" />
              </div>
              <h3>{t.name}</h3>
              <Badge value={t.risk} />
              <p>
                {t.resource_id} · {t.resource_version}
              </p>
              <footer>
                <span>
                  {t.enabled ? translate("已开放") : translate("已停用")}
                </span>
                {w.roles.includes("ADMIN") && (
                  <Button
                    variant="ghost"
                    className="shrink-0 text-sm"
                    onClick={() => {
                      setSelected(t);
                      setCreating(true);
                    }}
                  >
                    {translate("管理策略")}
                  </Button>
                )}
              </footer>
            </Card>
          ))}
        </div>
      )}
      <Card className="panel mt-6">
        <div className="section-title">
          <h2>{translate("工具操作记录")}</h2>
          <Button
            variant="ghost"
            className="shrink-0 text-sm"
            onClick={() => load().catch(setError)}
          >
            {translate("刷新")}
          </Button>
        </div>
        {invocations.length ? (
          invocations.map((i) => (
            <div className="record-row" key={i.id}>
              <span>
                {w.tools.find((t) => t.id === i.binding.tool_id)?.name ||
                  i.binding.tool_id}
                <small>
                  {short(i.id)} · {stamp(i.created_at)}
                </small>
              </span>
              <Badge value={i.status} />
              {i.status === "UNKNOWN" && w.roles.includes("ADMIN") && (
                <Action
                  run={async () => {
                    await w.api.call(
                      `/tool-invocations/${i.id}/reconcile`,
                      {
                        reason:
                          "Administrator queried the external operation result",
                      },
                      i.version,
                    );
                    await load();
                  }}
                >
                  {translate("查询外部结果")}
                </Action>
              )}
            </div>
          ))
        ) : (
          <p className="text-sm leading-6 text-slate-600">
            {translate("暂无可查看的操作记录。")}
          </p>
        )}
      </Card>
      {creating && (
        <Modal
          title={
            selected ? translate("更新工具策略") : translate("注册工具策略")
          }
          close={() => setCreating(false)}
        >
          {!backends.length ? (
            <div className="notice">
              {translate(
                "当前没有配置下游工具。请由部署管理员配置工具目录后重启 API 与 Worker。",
              )}
            </div>
          ) : (
            <Form
              submit={translate("保存工具策略")}
              onDone={() => setCreating(false)}
              action={async (data) => {
                const body = {
                  backend_id: selected?.backend_id || text(data, "backend"),
                  name: text(data, "name"),
                  resource_version: text(data, "revision"),
                  enabled: data.has("enabled"),
                  reason: text(data, "reason"),
                };
                if (selected)
                  await w.api.call(
                    `/tools/${selected.id}/changes`,
                    body,
                    selected.version,
                  );
                else await w.api.call(`/projects/${w.project.id}/tools`, body);
                await w.refresh();
              }}
            >
              {fields}
            </Form>
          )}
        </Modal>
      )}
    </>
  );
}
