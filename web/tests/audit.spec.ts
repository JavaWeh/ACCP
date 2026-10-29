// Pure/unit coverage for the F4 audit toolbar. The query serializer (filter →
// server query string; applying/clearing drops the cursor to reset pagination,
// US-11b) and the export-role gate (REVIEWER never sees export, Q-N4=B) are
// extracted as module-level pure functions and tested directly, mirroring the
// notifications spec. Full DOM behaviour (toolbar render, blob download,
// REVIEWER has no export button in the live page) is residual managed-server
// e2e.
import { expect, test } from "@playwright/test";
import {
  auditQuery,
  canExportAudit,
  emptyAuditFilters,
} from "../src/workspace/AuditRecords";

test("auditQuery omits empty filters and the cursor on apply/clear", () => {
  // Empty filters + no cursor (the state right after apply/clear) → no query.
  expect(auditQuery(emptyAuditFilters)).toBe("");
  // Applying filters carries them but still no cursor: pagination resets.
  const q = auditQuery({ ...emptyAuditFilters, actor: "user_a", action: "x" });
  expect(q).toContain("actor=user_a");
  expect(q).toContain("action=x");
  expect(q).not.toContain("cursor=");
});

test("auditQuery includes the cursor only when loading more", () => {
  const q = auditQuery(emptyAuditFilters, { cursor: "abc", limit: 50 });
  expect(q).toContain("cursor=abc");
  expect(q).toContain("limit=50");
});

test("auditQuery passes the export format through", () => {
  expect(auditQuery(emptyAuditFilters, { format: "csv" })).toBe("?format=csv");
  const scoped = auditQuery(
    { ...emptyAuditFilters, project: "p1" },
    { format: "jsonl" },
  );
  expect(scoped).toBe("?project=p1&format=jsonl");
});

test("canExportAudit gates export on ADMIN, never REVIEWER", () => {
  expect(canExportAudit(["ADMIN"])).toBe(true);
  expect(canExportAudit(["REVIEWER", "MEMBER"])).toBe(false);
  expect(canExportAudit(["REVIEWER"])).toBe(false);
  expect(canExportAudit([])).toBe(false);
});
