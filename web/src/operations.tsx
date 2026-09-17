import { useEffect, useState } from "react";
import type { Workspace } from "./main";
import type { Doc, Page } from "./api";
import { HandoffDownloads } from "./handoff";
import { Button, Empty, Field, Form, Input, Json, Message, text } from "./ui";

export function Operations({ w }: { w: Workspace }) {
  const [diagnostics, setDiagnostics] = useState<Doc>();
  const [failures, setFailures] = useState<Page>({ items: [] });
  const [operations, setOperations] = useState<Page>({ items: [] });
  const [error, setError] = useState<unknown>();
  const [cursor, setCursor] = useState("");
  const [operationCursor, setOperationCursor] = useState("");
  const admin = w.roles.includes("ADMIN");
  async function refresh() {
    if (!admin) return;
    const [d, f, o] = await Promise.all([
      w.api.call(`/projects/${w.project.id}/diagnostics`),
      w.api.call<Page>(
        `/projects/${w.project.id}/event-failures?limit=25&cursor=${encodeURIComponent(cursor)}`,
      ),
      w.api.call<Page>(
        `/projects/${w.project.id}/tool-invocations?limit=25&cursor=${encodeURIComponent(operationCursor)}`,
      ),
    ]);
    setDiagnostics(d);
    setFailures(f);
    setOperations(o);
    setError(undefined);
  }
  useEffect(() => {
    refresh().catch(setError);
  }, [w.api, w.project.id, admin, cursor, operationCursor]);
  if (!admin) return <Empty title="需要当前项目管理员权限" />;
  return (
    <div className="space-y-6">
      <HandoffDownloads key={w.project.id} w={w} />
      <p>先核对失败原因与外部结果，再执行重放或核对。UNKNOWN 不会自动重试。</p>
      <Button onPress={() => refresh().catch(setError)}>刷新诊断</Button>
      {error !== undefined && <Message error={error} />}
      {diagnostics ? (
        <Json data={diagnostics} />
      ) : (
        <Empty title="正在加载诊断" />
      )}
      <h2>失败事件</h2>
      {!failures.items.length && <Empty title="没有失败事件" />}
      {failures.items.map((event) => (
        <section key={event.id} className="panel">
          <Json data={event} />
          <Form
            submit="授权重放"
            action={async (data) => {
              await w.api.call(
                `/projects/${w.project.id}/events/${event.id}/replay`,
                { reason: text(data, "reason") },
              );
              await refresh();
            }}
          >
            <Field label="重放原因">
              <Input name="reason" required maxLength={2000} />
            </Field>
          </Form>
        </section>
      ))}
      <Button isDisabled={!cursor} onPress={() => setCursor("")}>
        事件首页
      </Button>
      <Button
        isDisabled={!failures.next_cursor}
        onPress={() => setCursor(failures.next_cursor || "")}
      >
        下一页事件
      </Button>
      <h2>操作核对</h2>
      {operations.items.map((op) => (
        <section key={op.id} className="panel">
          <Json data={op} />
          {op.status === "UNKNOWN" && (
            <Form
              submit="查询外部结果并核对"
              action={async (data) => {
                await w.api.call(
                  `/tool-invocations/${op.id}/reconcile`,
                  { reason: text(data, "reason") },
                  op.version,
                );
                await refresh();
              }}
            >
              <Field label="核对原因">
                <Input name="reason" required maxLength={2000} />
              </Field>
            </Form>
          )}
        </section>
      ))}
      {!operations.items.length && <Empty title="没有工具操作" />}
      <Button
        isDisabled={!operationCursor}
        onPress={() => setOperationCursor("")}
      >
        操作首页
      </Button>
      <Button
        isDisabled={!operations.next_cursor}
        onPress={() => setOperationCursor(operations.next_cursor || "")}
      >
        下一页操作
      </Button>
    </div>
  );
}
