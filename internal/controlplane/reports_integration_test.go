//go:build integration

package controlplane

import "testing"

func TestM2HumanCanReadExecutionReports(t *testing.T) {
	f := setupExecution(t)
	task := f.readyTask()
	run := f.claim(task, newID("key"))["run"].(map[string]any)
	f.expect(f.runWrite(f.token, run, "/reports", newID("key"), Object{"kind": "PROGRESS", "progress_percent": 42, "message": "API contract drafted"}), 200, "M2TaskRun")
	path := "/task-runs/" + textValue(run, "id") + "/reports"
	reports := f.expect(f.call("bob", "GET", path, "", "", nil), 200, "M2RunReportPage")
	entries := reports["items"].([]any)
	if len(entries) != 1 || entries[0].(map[string]any)["report"].(map[string]any)["progress_percent"] != float64(42) {
		t.Fatal("human cannot inspect progress")
	}
	f.expect(f.call(f.token, "GET", path, "", "", nil), 200, "M2RunReportPage")
	f.expect(f.call("carol", "GET", path, "", "", nil), 404, "")
}
