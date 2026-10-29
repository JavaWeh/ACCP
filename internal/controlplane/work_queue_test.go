package controlplane

import "testing"

func TestWorkGroup(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		status, want string
	}{
		{"IN_REVIEW", "review"},
		{"BLOCKED", "blocked"},
		{"FAILED", "blocked"},
		{"READY", ""},
		{"DRAFT", ""},
		{"DONE", ""},
		{"", ""},
	} {
		if got := workGroup(tc.status); got != tc.want {
			t.Fatalf("workGroup(%q)=%q, want %q", tc.status, got, tc.want)
		}
	}
}

func TestApprovalTitle(t *testing.T) {
	t.Parallel()
	title := "Implement orders"
	tool := "git.merge"
	empty := ""
	cases := []struct {
		taskTitle, toolID *string
		want              string
	}{
		{&title, &tool, title},
		{nil, &tool, tool},
		{&empty, &tool, tool},
		{nil, nil, ""},
	}
	for i, tc := range cases {
		if got := approvalTitle(tc.taskTitle, tc.toolID); got != tc.want {
			t.Fatalf("case %d: approvalTitle=%q, want %q", i, got, tc.want)
		}
	}
}

func TestNullableTextAndDeref(t *testing.T) {
	t.Parallel()
	if v := nullableText(nil); v != nil {
		t.Fatalf("nullableText(nil)=%v, want nil", v)
	}
	value := "task_1"
	if v := nullableText(&value); v != "task_1" {
		t.Fatalf("nullableText(&value)=%v, want task_1", v)
	}
	if deref(nil) != "" {
		t.Fatal("deref(nil) should be empty")
	}
	if deref(&value) != "task_1" {
		t.Fatalf("deref(&value)=%q, want task_1", deref(&value))
	}
}
