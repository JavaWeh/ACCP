//go:build integration

package controlplane

import (
	"context"
	"testing"
)

func TestTaskChangeEvidenceCannotBeRewritten(t *testing.T) {
	f := setup(t)
	_, v := f.candidate("bob")
	task := f.expect(f.call("bob", "POST", "/projects/project_demo/tasks", newID("key"), "", taskBody(textValue(v, "id"))), 201, "Task")
	f.expect(f.call("bob", "POST", "/tasks/"+textValue(task, "id")+"/changes", newID("key"), `"1"`, Object{"title": "Corrected", "objective": "Clarified", "acceptance_criteria": []string{"Reviewed"}, "reason": "Retain evidence"}), 200, "Task")
	for _, sql := range []string{`UPDATE task_changes SET document='{}'`, `DELETE FROM task_changes`} {
		if _, err := f.pool.Exec(context.Background(), sql); err == nil {
			t.Fatal("immutable history was modified")
		}
	}
	var count int
	if err := f.pool.QueryRow(context.Background(), `SELECT count(*) FROM task_changes`).Scan(&count); err != nil || count != 1 {
		t.Fatal("history was lost", err)
	}
}
