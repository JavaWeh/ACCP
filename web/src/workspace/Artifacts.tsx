import { useI18n } from "../i18n";
import { Card, Table } from "@heroui/react";
import { useState } from "react";
import type { Workspace } from "../main";
import type { Doc } from "../api";
import { short } from "../api";
import {
  Button,
  Select,
  TextArea,
  Action,
  Badge,
  Empty,
  Field,
  Form,
  Json,
  Message,
  Modal,
  text,
} from "../ui";
import { reviewer } from "./reviewer";

export function Artifacts({ w }: { w: Workspace }) {
  const { translate, label, stamp } = useI18n();

  const [selected, setSelected] = useState<Doc>();
  const [content, setContent] = useState("");
  const [history, setHistory] = useState<Doc[]>([]);
  const [error, setError] = useState<unknown>();
  async function open(a: Doc) {
    try {
      const current = await w.api.call(`/artifacts/${a.id}`);
      setSelected(current);
      setContent("");
      const [reviews, checks] = await Promise.all([
        w.api.all(`/artifacts/${a.id}/reviews`),
        w.api.all(`/artifacts/${a.id}/verifications`),
      ]);
      setHistory([...reviews, ...checks]);
      if (current.uri.startsWith("urn:accp:artifact-content:")) {
        const text = await w.api.call(
          `/artifact-contents/${current.uri.split(":").at(-1)}`,
        );
        setContent(text.content);
      }
    } catch (e) {
      setError(e);
    }
  }
  return (
    <>
      {error !== undefined && <Message error={error} />}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4 [&>p]:text-sm [&>p]:text-slate-600">
        <p className="text-sm leading-6 text-slate-600">
          {translate("核验内容与来源，再由人类接受成果。")}
        </p>
        <span className="text-sm text-slate-600">
          {translate("{count} 份成果", { count: w.artifacts.length })}
        </span>
      </div>
      {!w.artifacts.length ? (
        <Empty title={translate("尚无交付成果")}>
          {translate("Agent 执行任务后，成果会连同来源与核验状态显示在这里。")}
        </Empty>
      ) : (
        <Card className="panel table-wrap">
          <Table>
            <Table.ScrollContainer>
              <Table.Content aria-label={translate("交付成果")}>
                <Table.Header>
                  <Table.Column isRowHeader>{translate("成果")}</Table.Column>
                  <Table.Column>{translate("所属任务")}</Table.Column>
                  <Table.Column>{translate("核验")}</Table.Column>
                  <Table.Column>{translate("人工接受")}</Table.Column>
                  <Table.Column>{translate("负责人")}</Table.Column>
                  <Table.Column>{translate("操作")}</Table.Column>
                </Table.Header>
                <Table.Body>
                  {w.artifacts.map((a) => (
                    <Table.Row key={a.id} id={a.id}>
                      <Table.Cell>
                        <strong>{label(a.kind)}</strong>
                        <small>{short(a.id)}</small>
                      </Table.Cell>
                      <Table.Cell>
                        {w.tasks.find((t) => t.id === a.provenance.task_id)
                          ?.title || short(a.provenance.task_id)}
                      </Table.Cell>
                      <Table.Cell>
                        <Badge value={a.verification_status} />
                      </Table.Cell>
                      <Table.Cell>
                        <Badge value={a.acceptance_status} />
                      </Table.Cell>
                      <Table.Cell>{a.provenance.owner_user_id}</Table.Cell>
                      <Table.Cell>
                        <Button
                          variant="ghost"
                          className="shrink-0 text-sm"
                          onClick={() => open(a)}
                        >
                          {translate("查看 →")}
                        </Button>
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>
          </Table>
        </Card>
      )}
      {selected && (
        <Modal
          title={translate("{kind} · 成果详情", { kind: label(selected.kind) })}
          close={() => setSelected(undefined)}
        >
          <div className="mb-5 flex flex-wrap items-center gap-3 text-sm text-slate-600">
            <Badge value={selected.verification_status} />
            <Badge value={selected.acceptance_status} />
            <span>
              {translate("版本 {version}", { version: selected.version })}
            </span>
          </div>
          <dl className="facts">
            <dt>{translate("内容摘要")}</dt>
            <dd className="font-mono text-xs break-all">
              {selected.content_digest}
            </dd>
            <dt>{translate("不可变版本")}</dt>
            <dd className="font-mono text-xs break-all">
              {selected.immutable_revision || translate("已存储的正文摘要")}
            </dd>
            <dt>{translate("成果引用")}</dt>
            <dd>
              {/^https:\/\//.test(selected.uri) ? (
                <a href={selected.uri} target="_blank" rel="noreferrer">
                  {selected.uri} ↗
                </a>
              ) : (
                selected.uri
              )}
            </dd>
          </dl>
          {content && (
            <pre className="my-4 max-h-96 overflow-auto rounded-lg border border-slate-200 bg-slate-50 p-5 text-sm leading-7 whitespace-pre-wrap break-words">
              {content}
            </pre>
          )}
          {reviewer(w) && selected.acceptance_status === "PENDING" && (
            <div className="mt-6 rounded-xl border border-slate-200 bg-slate-50 p-5">
              {["COMMIT", "PULL_REQUEST", "CODE_DIFF"].includes(
                selected.kind,
              ) && (
                <Action
                  run={async () => {
                    await w.api.call(
                      `/artifacts/${selected.id}/verifications`,
                      { reason: "Human requested Git provider verification" },
                      selected.version,
                    );
                    await w.refresh();
                    await open(selected);
                  }}
                >
                  {translate("从 Git 服务核验当前版本")}
                </Action>
              )}
              <Form
                submit={translate("提交成果审核")}
                action={async (data) => {
                  await w.api.call(
                    `/artifacts/${selected.id}/reviews`,
                    {
                      decision: text(data, "decision"),
                      content_digest: selected.content_digest,
                      reason: text(data, "reason"),
                    },
                    selected.version,
                  );
                  await w.refresh();
                  await open(selected);
                }}
              >
                <Field label={translate("决定")}>
                  <Select name="decision">
                    <option value="ACCEPT">{translate("接受成果")}</option>
                    <option value="REJECT">{translate("拒绝成果")}</option>
                  </Select>
                </Field>
                <Field label={translate("审核依据")}>
                  <TextArea
                    name="reason"
                    required
                    placeholder={translate("说明已核对的内容与证据")}
                  />
                </Field>
              </Form>
            </div>
          )}
          <h3>{translate("来源追踪")}</h3>
          <Json data={selected.provenance} />
          <h3>{translate("核验与人工审核记录")}</h3>
          {history.length ? (
            history.map((r) => (
              <div className="timeline-item" key={r.id}>
                <strong>
                  {r.decision || r.status} ·{" "}
                  {r.reviewed_by_user_id || r.verified_by_user_id}
                </strong>
                <small>{stamp(r.created_at)}</small>
                <p>
                  {r.reason || r.error_code || translate("Git 服务核验通过")}
                </p>
              </div>
            ))
          ) : (
            <p className="text-sm leading-6 text-slate-600">
              {translate("暂无外部核验或人工审核记录。")}
            </p>
          )}
        </Modal>
      )}
    </>
  );
}
