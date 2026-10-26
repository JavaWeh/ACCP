import { useI18n } from "../i18n";
import type { Doc } from "../api";
import type { ReactNode } from "react";
import { Input, Select, Field, Form, Modal } from "../ui";

export function ContextCreateModal({
  close,
  sourceMode,
  setSourceMode,
  gitRepositories,
  createGit,
  save,
  fields,
}: {
  close: () => void;
  sourceMode: string;
  setSourceMode: (value: string) => void;
  gitRepositories: Doc[];
  createGit: (data: FormData) => Promise<void>;
  save: (data: FormData) => Promise<void>;
  fields: ReactNode;
}) {
  const { translate, label } = useI18n();
  return (
    <Modal title={translate("新建共享上下文")} close={close}>
      <Field label={translate("资料来源")}>
        <Select value={sourceMode} onChange={setSourceMode}>
          <option value="ACCP">ACCP</option>
          <option value="GIT">GitHub</option>
        </Select>
      </Field>
      <Form
        submit={
          sourceMode === "GIT"
            ? translate("创建 Git 来源")
            : translate("创建候选版本")
        }
        onDone={close}
        action={(data) => (sourceMode === "GIT" ? createGit(data) : save(data))}
      >
        <Field label={translate("名称")}>
          <Input
            name="name"
            required
            placeholder={translate("例如：订单查询 API")}
          />
        </Field>
        <Field label={translate("类型")}>
          <Select name="type">
            {["REQUIREMENT", "API", "DB_SCHEMA", "ADR", "PROJECT_STANDARD"].map(
              (t) => (
                <option value={t} key={t}>
                  {t === "PROJECT_STANDARD" ? translate("项目规范") : label(t)}
                </option>
              ),
            )}
          </Select>
        </Field>
        {sourceMode === "GIT" ? (
          <>
            <Field label={translate("已登记的 GitHub 仓库")}>
              <Select name="repository" required>
                {gitRepositories.map((repo) => (
                  <option key={repo.id} value={repo.id}>
                    {repo.url}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={translate("仓库内文档路径")}>
              <Input name="path" required placeholder="docs/api.md" />
            </Field>
            <p className="text-sm text-slate-600">
              {translate("创建来源后，按完整 Commit SHA 同步候选版本。")}
            </p>
          </>
        ) : (
          fields
        )}
      </Form>
    </Modal>
  );
}
