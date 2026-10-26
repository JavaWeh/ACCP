import { useI18n, LocalizedError } from "../i18n";
import { Tabs } from "@heroui/react";
import type { Doc } from "../api";
import { short } from "../api";
import type { Workspace } from "../main";
import {
  Select,
  TextArea,
  Checkbox,
  Badge,
  Empty,
  Field,
  Form,
  text,
} from "../ui";

export function TaskEvidencePanel({
  w,
  id,
  task,
  run,
  artifacts,
  reviewDecision,
  setReviewDecision,
  refreshed,
}: {
  w: Workspace;
  id: string;
  task: Doc;
  run: Doc | undefined;
  artifacts: Doc[];
  reviewDecision: string;
  setReviewDecision: (value: string) => void;
  refreshed: () => Promise<void>;
}) {
  const { translate, label } = useI18n();
  return (
    <Tabs.Panel id="evidence">
      {!artifacts.length ? (
        <Empty title={translate("等待执行成果")}>
          {translate("Agent 需要提交可核验的文档、代码或测试证据。")}
        </Empty>
      ) : (
        artifacts.map((a) => (
          <article className="record-row" key={a.id}>
            <span>
              <strong>{label(a.kind)}</strong>
              <small>{a.uri || short(a.id)}</small>
              {a.content_digest && (
                <small>
                  {translate("内容摘要：{digest}", {
                    digest: short(a.content_digest),
                  })}
                </small>
              )}
            </span>
            <Badge value={a.verification_status} />
            <Badge value={a.acceptance_status} />
          </article>
        ))
      )}
      {task.status === "IN_REVIEW" && task.owner_user_id === w.me.id && run && (
        <div className="mt-6 rounded-xl border border-slate-200 bg-slate-50 p-5">
          <h3>{translate("Owner 最终验收")}</h3>
          <p className="text-sm leading-6 text-slate-600">
            {translate(
              "对照验收条件检查成果；只有全部满足且证据已核验，才能接受交付。",
            )}
          </p>
          <Form
            submit={translate("提交验收决定")}
            action={async (data) => {
              const selected = data
                .getAll("artifact")
                .map((value) => artifacts.find((a) => a.id === value)!);
              if (reviewDecision === "ACCEPT") {
                if (
                  task.acceptance_criteria.some(
                    (_: string, i: number) => !data.has(`criterion_${i}`),
                  )
                )
                  throw new LocalizedError(
                    "请先确认全部验收条件，或选择退回修改。",
                  );
                if (
                  !selected.length ||
                  selected.some((a) => a.verification_status !== "VERIFIED")
                )
                  throw new LocalizedError(
                    "接受交付前，请绑定至少一项已核验成果。",
                  );
              }
              await w.api.call(
                `/tasks/${id}/reviews`,
                {
                  decision: text(data, "decision"),
                  task_run_id: run.id,
                  artifacts: selected.map((a) => ({
                    artifact_id: a.id,
                    version: a.version,
                    content_digest: a.content_digest,
                  })),
                  acceptance_checks: task.acceptance_criteria.map(
                    (_: string, i: number) => data.has(`criterion_${i}`),
                  ),
                  reason: text(data, "reason"),
                },
                task.version,
              );
              await refreshed();
            }}
          >
            <fieldset>
              <legend>{translate("逐项检查验收条件")}</legend>
              {task.acceptance_criteria.map((c: string, i: number) => (
                <Checkbox key={i} name={`criterion_${i}`}>
                  {c}
                </Checkbox>
              ))}
            </fieldset>
            <fieldset>
              <legend>{translate("绑定本次验收成果")}</legend>
              {artifacts.map((a) => (
                <Checkbox
                  key={a.id}
                  name="artifact"
                  value={a.id}
                  defaultSelected
                >
                  {label(a.kind)} · {short(a.id)} · v{a.version}
                </Checkbox>
              ))}
            </fieldset>
            <Field label={translate("验收决定")}>
              <Select name="decision" onChange={setReviewDecision}>
                <option value="ACCEPT">
                  {translate("接受成果，完成任务")}
                </option>
                <option value="REJECT">{translate("退回修改")}</option>
              </Select>
            </Field>
            <Field label={translate("审核意见")}>
              <TextArea
                name="reason"
                required
                placeholder={translate("说明验收证据或需要修改的内容")}
              />
            </Field>
          </Form>
        </div>
      )}
    </Tabs.Panel>
  );
}
