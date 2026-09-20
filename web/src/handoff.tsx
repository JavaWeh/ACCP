import { useState } from "react";
import type { Workspace } from "./main";
import type { Page } from "./api";
import { Action } from "./ui";

function download(name: string, data: unknown) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function HandoffDownloads({ w }: { w: Workspace }) {
  const [cursor, setCursor] = useState(""),
    [pages, setPages] = useState(0),
    [finished, setFinished] = useState(false);
  return (
    <section>
      <h2>交接导出</h2>
      <p>
        审计每次下载 100
        条并重新校验权限。完整一致性快照请使用管理员手册中的本机导出命令。
      </p>
      <Action
        run={async () =>
          download(
            `diagnostics-${w.project.id}.json`,
            await w.api.call(`/projects/${w.project.id}/diagnostics`),
          )
        }
      >
        下载项目诊断
      </Action>
      {!finished && (
        <Action
          run={async () => {
            const result = await w.api.call<Page>(
              `/projects/${w.project.id}/audit-export?limit=100${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`,
            );
            download(`audit-${w.project.id}-${pages + 1}.json`, {
              project_id: w.project.id,
              exported_at: new Date().toISOString(),
              ...result,
            });
            setPages(pages + 1);
            setCursor(result.next_cursor || "");
            setFinished(!result.next_cursor);
          }}
        >
          下载下一页审计
        </Action>
      )}
      <p>
        已下载 {pages} 页{finished ? "，本次分页结束。" : ""}
      </p>
    </section>
  );
}
