import { useI18n, LocalizedError } from "../i18n";
import { useEffect, useState } from "react";
import type { Doc } from "../api";
import type { Workspace } from "../main";
import {
  Input,
  Select,
  TextArea,
  Empty,
  Field,
  Form,
  Message,
  Modal,
  text,
} from "../ui";

export function CreateTask({
  w,
  close,
  checkList,
}: {
  w: Workspace;
  close: () => void;
  checkList: () => void;
}) {
  const { translate } = useI18n();

  const [versions, setVersions] = useState<Doc[]>([]);
  const [repos, setRepos] = useState<Doc[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    Promise.all([
      Promise.all(
        w.contexts.map((c) =>
          w.api
            .all(`/contexts/${c.id}/versions`)
            .then((v) => v.map((x): Doc => ({ ...x, context_name: c.name }))),
        ),
      ),
      w.api.all(`/projects/${w.project.id}/repositories`),
    ])
      .then(([v, r]) => {
        setVersions(v.flat().filter((x) => x.status === "PUBLISHED"));
        setRepos(r);
        setLoaded(true);
      })
      .catch((cause) => {
        setError(cause);
        setLoaded(true);
      });
  }, [w.api, w.project.id, w.contexts]);
  return (
    <Modal title={translate("创建协作任务")} close={close}>
      {error !== undefined && <Message error={error} />}
      {!loaded ? (
        <p>{translate("正在准备任务所需资料…")}</p>
      ) : !repos.length || !versions.length ? (
        <Empty title={translate("创建任务前还需准备")}>
          {!repos.length
            ? translate("请管理员先在项目设置中登记代码仓库。")
            : translate("请先在项目资料中发布需求或接口说明。")}
        </Empty>
      ) : (
        <Form
          submit={translate("创建草稿")}
          onDone={close}
          safeRetry={{ onCheck: checkList }}
          action={async (data, idempotencyKey) => {
            const criteria = text(data, "criteria")
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean);
            if (!criteria.length)
              throw new LocalizedError("请至少填写一条验收条件。");
            if (!data.getAll("contexts").length)
              throw new LocalizedError("请至少选择一项项目资料。");
            let idempotencyReplayed = false;
            await w.api.call(
              `/projects/${w.project.id}/tasks`,
              {
                title: text(data, "title"),
                objective: text(data, "objective"),
                owner_user_id: text(data, "owner"),
                repository_id: text(data, "repo"),
                acceptance_criteria: criteria,
                context_version_ids: data.getAll("contexts"),
              },
              undefined,
              {
                idempotencyKey,
                uncertainResult: true,
                onResponse: (metadata) => {
                  idempotencyReplayed = metadata.idempotencyReplayed;
                },
              },
            );
            // A refresh failure must not turn a confirmed write into another submit.
            try {
              await w.refresh();
            } catch (cause) {
              setError(cause);
              return { idempotencyReplayed, keepOpen: true };
            }
            return { idempotencyReplayed };
          }}
        >
          <p className="text-sm leading-6 text-slate-600">
            {translate(
              "先写清要交付什么，再指定负责人和验收标准。创建后可检查并提交执行。",
            )}
          </p>
          <h3>{translate("一、明确交付目标")}</h3>
          <Field label={translate("任务标题")}>
            <Input
              name="title"
              required
              maxLength={200}
              placeholder={translate("例如：实现订单查询 API")}
            />
          </Field>
          <Field label={translate("目标与范围")}>
            <TextArea
              name="objective"
              required
              rows={3}
              placeholder={translate("说明预期结果和本次交付范围")}
            />
          </Field>
          <h3>{translate("二、指定负责人和仓库")}</h3>
          <div className="grid grid-cols-1 gap-x-5 sm:grid-cols-2">
            <Field label={translate("人类负责人")}>
              <Select name="owner" defaultValue={w.me.id}>
                {w.members
                  .filter((m) => m.active)
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.display_name || m.id}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label={translate("代码仓库")}>
              <Select name="repo" required>
                {repos.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.url}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <h3>{translate("三、写下验收标准和项目资料")}</h3>
          <Field
            label={translate("验收条件")}
            hint={translate("每行一项；最终由 Owner 逐项确认。")}
          >
            <TextArea
              name="criteria"
              required
              rows={3}
              placeholder={translate(
                "能够按订单编号返回订单信息\n权限校验和测试通过",
              )}
            />
          </Field>
          <Field
            label={translate("执行依据")}
            hint={translate(
              "选择已发布的明确版本。任务领取后，输入会固定为执行快照。",
            )}
          >
            <Select name="contexts" multiple required>
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.context_name} · {v.source_revision}
                </option>
              ))}
            </Select>
          </Field>
        </Form>
      )}
    </Modal>
  );
}
