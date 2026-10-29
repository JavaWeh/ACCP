import { useI18n } from "../i18n";
import type { Workspace } from "../main";
import { Empty } from "../ui";
import { reviewer } from "./reviewer";
import { AuditRecords, canExportAudit } from "./AuditRecords";

export function Audit({ w }: { w: Workspace }) {
  const { translate } = useI18n();
  if (!reviewer(w))
    return (
      <Empty title={translate("审计记录需要审核权限")}>
        {translate("请联系项目管理员授予相应角色。")}
      </Empty>
    );
  return (
    <AuditRecords
      api={w.api}
      listPath={`/projects/${w.project.id}/audit-records`}
      exportPath={`/projects/${w.project.id}/audit-records/export`}
      canExport={canExportAudit(w.roles)}
    />
  );
}
