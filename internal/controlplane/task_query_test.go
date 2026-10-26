package controlplane

import (
	"net/url"
	"testing"
)

func TestParseTaskListSort(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		query, wantSort, wantOrder, wantCode string
		sorted                               bool
	}{
		{query: "", sorted: false},
		{query: "sort=updated_at", wantSort: "updated_at", wantOrder: "desc", sorted: true},
		{query: "sort=title", wantSort: "title", wantOrder: "asc", sorted: true},
		{query: "sort=updated_at&order=asc", wantSort: "updated_at", wantOrder: "asc", sorted: true},
		{query: "sort=title&order=desc", wantSort: "title", wantOrder: "desc", sorted: true},
		{query: "sort=created_at", wantCode: "INVALID_SORT"},
		{query: "sort=", wantCode: "INVALID_SORT"},
		{query: "sort=Updated_At", wantCode: "INVALID_SORT"},
		{query: "order=desc", wantCode: "INVALID_ORDER"},
		{query: "sort=title&order=up", wantCode: "INVALID_ORDER"},
		{query: "sort=title&order=", wantCode: "INVALID_ORDER"},
	} {
		params, _ := url.ParseQuery(tc.query)
		sortField, order, sorted, err := parseTaskListSort(params)
		if tc.wantCode != "" {
			if err == nil || err.Error() != tc.wantCode {
				t.Fatalf("%q: got err %v, want %s", tc.query, err, tc.wantCode)
			}
			continue
		}
		if err != nil || sorted != tc.sorted || sortField != tc.wantSort || order != tc.wantOrder {
			t.Fatalf("%q: got (%q,%q,%v,%v)", tc.query, sortField, order, sorted, err)
		}
	}
}

func TestTaskListFingerprintResolvedDefaults(t *testing.T) {
	t.Parallel()
	omitted, _ := url.ParseQuery("sort=updated_at&q=Orders")
	explicit, _ := url.ParseQuery("sort=updated_at&order=desc&q=Orders&cursor=abc&limit=2")
	aSort, aOrder, aSorted, err := parseTaskListSort(omitted)
	if err != nil {
		t.Fatal(err)
	}
	bSort, bOrder, bSorted, err := parseTaskListSort(explicit)
	if err != nil {
		t.Fatal(err)
	}
	a := taskListFingerprint(omitted, aSort, aOrder, aSorted)
	b := taskListFingerprint(explicit, bSort, bOrder, bSorted)
	if a != b || a != "order=desc&q=Orders&sort=updated_at" {
		t.Fatalf("fingerprint mismatch: %q vs %q", a, b)
	}
	titleOmitted, _ := url.ParseQuery("sort=title")
	titleExplicit, _ := url.ParseQuery("sort=title&order=asc")
	ts, to, sorted, err := parseTaskListSort(titleOmitted)
	if err != nil {
		t.Fatal(err)
	}
	es, eo, _, err := parseTaskListSort(titleExplicit)
	if err != nil {
		t.Fatal(err)
	}
	if taskListFingerprint(titleOmitted, ts, to, sorted) != taskListFingerprint(titleExplicit, es, eo, true) {
		t.Fatal("title default fingerprint diverged")
	}
	unsorted, _ := url.ParseQuery("q=Orders&cursor=x&limit=1")
	if got := taskListFingerprint(unsorted, "", "", false); got != "q=Orders" {
		t.Fatalf("unsorted fingerprint %q", got)
	}
}

func TestTaskCursorRoundTripAndMissingV(t *testing.T) {
	t.Parallel()
	path := "/api/v1/projects/project_demo/tasks"
	encoded := encodeTaskCursor(taskCursor{Path: path, ID: "task_1", V: "2026-01-02T03:04:05.006Z", Filter: "order=desc&sort=updated_at"})
	got, err := decodeTaskCursor(encoded, path)
	if err != nil || got.ID != "task_1" || got.V == "" || got.Filter == "" || got.Path != path {
		t.Fatalf("round-trip failed: %+v %v", got, err)
	}
	noV := encodeTaskCursor(taskCursor{Path: path, ID: "task_1", Filter: "order=desc&sort=updated_at"})
	decoded, err := decodeTaskCursor(noV, path)
	if err != nil {
		t.Fatal(err)
	}
	if decoded.V != "" {
		t.Fatal("expected empty V")
	}
	if _, err = decodeTaskCursor("@@@", path); err == nil || err.Error() != "INVALID_CURSOR" {
		t.Fatalf("bad cursor: %v", err)
	}
}

func TestTaskKeysetClause(t *testing.T) {
	t.Parallel()
	updated := taskSortExpression("updated_at")
	title := taskSortExpression("title")
	cases := []struct {
		expr string
		asc  bool
		want string
	}{
		{updated, true, `((document->>'updated_at')::timestamptz > $3 OR ((document->>'updated_at')::timestamptz = $3 AND id > $4))`},
		{updated, false, `((document->>'updated_at')::timestamptz < $3 OR ((document->>'updated_at')::timestamptz = $3 AND id < $4))`},
		{title, true, `(coalesce(document->>'title','') > $3 OR (coalesce(document->>'title','') = $3 AND id > $4))`},
		{title, false, `(coalesce(document->>'title','') < $3 OR (coalesce(document->>'title','') = $3 AND id < $4))`},
	}
	for _, tc := range cases {
		if got := taskKeysetClause(tc.expr, tc.asc, 3, 4); got != tc.want {
			t.Fatalf("asc=%v\ngot  %s\nwant %s", tc.asc, got, tc.want)
		}
	}
}
