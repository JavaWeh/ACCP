import { useI18n } from "../i18n";
import { Card, Table } from "@heroui/react";
import { useState } from "react";
import type { Workspace } from "../main";
import type { Membership } from "../api";
import {
  Button,
  TextArea,
  Checkbox,
  Badge,
  Field,
  Form,
  Modal,
  text,
} from "../ui";

export function Members({ w }: { w: Workspace }) {
  const { translate, label } = useI18n();

  const [selected, setSelected] = useState<Membership>();
  return (
    <>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4 [&>p]:text-sm [&>p]:text-slate-600">
        <p className="text-sm leading-6 text-slate-600">
          {translate("企业身份与项目角色共同决定访问权限。")}
        </p>
      </div>
      <Card className="panel table-wrap">
        <Table>
          <Table.ScrollContainer>
            <Table.Content aria-label={translate("项目成员")}>
              <Table.Header>
                <Table.Column isRowHeader>{translate("成员")}</Table.Column>
                <Table.Column>{translate("项目角色")}</Table.Column>
                <Table.Column>{translate("状态")}</Table.Column>
                <Table.Column>{translate("操作")}</Table.Column>
              </Table.Header>
              <Table.Body>
                {w.members.map((m) => (
                  <Table.Row key={m.id} id={m.id}>
                    <Table.Cell>
                      <strong>{m.display_name || m.id}</strong>
                      <small>{m.id}</small>
                    </Table.Cell>
                    <Table.Cell>{m.roles.map(label).join(" / ")}</Table.Cell>
                    <Table.Cell>
                      <Badge value={m.active ? "ACTIVE" : "REVOKED"} />
                    </Table.Cell>
                    <Table.Cell>
                      {w.roles.includes("ADMIN") && (
                        <Button
                          variant="ghost"
                          className="shrink-0 text-sm"
                          onClick={() => setSelected(m)}
                        >
                          {translate("管理角色")}
                        </Button>
                      )}
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Content>
          </Table.ScrollContainer>
        </Table>
      </Card>
      {selected && (
        <Modal
          title={translate("管理 {name}", {
            name: selected.display_name || selected.id,
          })}
          close={() => setSelected(undefined)}
        >
          <Form
            submit={translate("保存成员权限")}
            onDone={() => setSelected(undefined)}
            action={async (data) => {
              await w.api.call(
                `/projects/${w.project.id}/members/${selected.id}/changes`,
                {
                  roles: data.getAll("roles"),
                  active: data.has("active"),
                  reason: text(data, "reason"),
                },
                selected.version,
              );
              await w.refresh();
            }}
          >
            <fieldset>
              <legend>{translate("角色")}</legend>
              {["ADMIN", "MEMBER", "REVIEWER", "VIEWER"].map((role) => (
                <Checkbox
                  key={role}
                  name="roles"
                  value={role}
                  defaultSelected={selected.roles.includes(role)}
                >
                  {label(role)}
                </Checkbox>
              ))}
            </fieldset>
            <Checkbox name="active" defaultSelected={selected.active}>
              {translate("启用成员访问")}
            </Checkbox>
            <Field label={translate("变更原因")}>
              <TextArea name="reason" required />
            </Field>
          </Form>
        </Modal>
      )}
    </>
  );
}
