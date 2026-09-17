// accp-bench operates only on an explicitly isolated, empty accp_capacity database.
// It runs the real HTTP control plane and JetStream worker; it is never shipped in runtime images.
package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"github.com/JavaWeh/ACCP/internal/auth"
	"github.com/JavaWeh/ACCP/internal/bootstrap"
	"github.com/JavaWeh/ACCP/internal/controlplane"
	"github.com/JavaWeh/ACCP/internal/database"
	"github.com/JavaWeh/ACCP/internal/eventbus"
	"github.com/JavaWeh/ACCP/internal/gateway"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

type object = map[string]any
type fixture struct {
	Credentials []bootstrap.Credential `json:"credentials"`
	Key         []byte                 `json:"key"`
	Versions    []string               `json:"versions"`
}
type client struct {
	url  string
	http *http.Client
}

func (c client) call(token, method, path string, body any, version any, fence any) (object, int, error) {
	raw, _ := json.Marshal(body)
	if body == nil {
		raw = nil
	}
	r, e := http.NewRequest(method, c.url+"/api/v1"+path, bytes.NewReader(raw))
	if e != nil {
		return nil, 0, e
	}
	r.Header.Set("Authorization", "Bearer "+token)
	r.Header.Set("Content-Type", "application/json")
	if method == "POST" {
		r.Header.Set("Idempotency-Key", key())
	}
	if version != nil {
		r.Header.Set("If-Match", fmt.Sprintf(`"%v"`, version))
	}
	if fence != nil {
		r.Header.Set("X-Run-Fencing-Token", fmt.Sprint(fence))
	}
	response, e := c.http.Do(r)
	if e != nil {
		return nil, 0, e
	}
	defer response.Body.Close()
	var value object
	e = json.NewDecoder(io.LimitReader(response.Body, 2<<20)).Decode(&value)
	return value, response.StatusCode, e
}
func key() string { b := make([]byte, 16); _, _ = rand.Read(b); return fmt.Sprintf("bench_%x", b) }
func must(value object, status int, err error) object {
	if err != nil || status < 200 || status >= 300 {
		panic(fmt.Sprintf("benchmark setup failed: status=%d code=%v error=%T", status, value["code"], err))
	}
	return value
}
func pid(i int) string { return fmt.Sprintf("project_%02d", i) }
func tid(i int) string { return fmt.Sprintf("task_%06d", i) }
func projectFor(i int) int {
	if i < 70000 {
		return 0
	}
	return 1 + (i-70000)%19
}
func serve(pool *pgxpool.Pool, f fixture, registries ...*gateway.Registry) (*controlplane.Server, *httptest.Server, client) {
	authPool, e := pgxpool.NewWithConfig(context.Background(), pool.Config())
	if e != nil {
		panic(e)
	}
	options := controlplane.Options{SessionKey: f.Key, PublicURL: "http://127.0.0.1"}
	if len(registries) > 0 {
		options.Tools = registries[0]
	}
	s, e := controlplane.New(pool, auth.Development{Pool: authPool}, options)
	if e != nil {
		panic(e)
	}
	h := httptest.NewServer(s)
	h.Config.RegisterOnShutdown(authPool.Close)
	return s, h, client{h.URL, &http.Client{Timeout: 15 * time.Second, Transport: &http.Transport{MaxIdleConns: 128, MaxIdleConnsPerHost: 128, MaxConnsPerHost: 128}}}
}
func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func run() error {
	mode := flag.String("mode", "run", "seed or run")
	config := flag.String("fixture", "/results/fixture.json", "private fixture file")
	output := flag.String("output", "/results/report.json", "report path")
	label := flag.String("label", "baseline", "report label")
	short := flag.Bool("smoke", false, "30 second smoke only, never capacity acceptance")
	flag.Parse()
	u, e := url.Parse(os.Getenv("DATABASE_URL"))
	if e != nil || u.Path != "/accp_capacity" || os.Getenv("ACCP_BENCH_ISOLATED") != "1" {
		return errors.New("requires ACCP_BENCH_ISOLATED=1 and dedicated accp_capacity database")
	}
	ctx := context.Background()
	query := u.Query()
	query.Set("search_path", "accp")
	u.RawQuery = query.Encode()
	pool, e := database.Open(ctx, u.String())
	if e != nil {
		return errors.New("isolated database unavailable")
	}
	defer pool.Close()
	if *mode == "seed" {
		return seed(ctx, pool, *config)
	}
	if *mode == "event-check" {
		return checkEvents(ctx, pool)
	}
	if *mode != "run" {
		return errors.New("mode must be seed, run or event-check")
	}
	raw, e := os.ReadFile(*config)
	if e != nil {
		return e
	}
	var f fixture
	if json.Unmarshal(raw, &f) != nil || len(f.Credentials) != 50 || len(f.Versions) != 20 {
		return errors.New("invalid isolated fixture")
	}
	return load(ctx, pool, f, *output, *label, *short)
}
func seed(ctx context.Context, pool *pgxpool.Pool, path string) error {
	if _, e := pool.Exec(ctx, `CREATE SCHEMA IF NOT EXISTS accp`); e != nil {
		return e
	}
	if e := database.Migrate(ctx, pool); e != nil {
		return e
	}
	spec := bootstrap.Spec{Organization: bootstrap.Organization{ID: "org_capacity", Name: "Isolated capacity fixture"}}
	for p := 0; p < 20; p++ {
		spec.Projects = append(spec.Projects, bootstrap.Project{ID: pid(p), Name: fmt.Sprintf("Capacity %02d", p), Repository: bootstrap.Repository{ID: fmt.Sprintf("repo_%02d", p), ProviderID: "github", URL: "https://github.com/JavaWeh/ACCP", DefaultBranch: "main"}})
	}
	for i := 0; i < 50; i++ {
		h := bootstrap.Human{ID: fmt.Sprintf("user_%02d", i), Issuer: "urn:accp:development", Subject: fmt.Sprintf("bench-%02d", i), DisplayName: fmt.Sprintf("Isolated %02d", i)}
		for p := 0; p < 20; p++ {
			if i == 49 && p != 19 {
				continue
			}
			roles := []string{"MEMBER", "REVIEWER"}
			if i == 0 {
				roles = append(roles, "ADMIN")
			}
			h.Memberships = append(h.Memberships, bootstrap.Membership{ProjectID: pid(p), Roles: roles})
		}
		spec.Humans = append(spec.Humans, h)
	}
	creds, e := bootstrap.Apply(ctx, pool, spec, true)
	if e != nil {
		return e
	}
	f := fixture{Credentials: creds, Key: make([]byte, 32)}
	_, _ = rand.Read(f.Key)
	_, h, c := serve(pool, f)
	defer h.Close()
	token := creds[0].Token
	for p := 0; p < 20; p++ {
		base := "/projects/" + pid(p)
		content := must(c.call(token, "POST", base+"/contents", object{"content": strings.Repeat("Capacity text evidence\n", 1024), "media_type": "text/plain"}, nil, nil))
		context := must(c.call(token, "POST", base+"/contexts", object{"name": "Capacity requirements", "type": "REQUIREMENT", "source": object{"kind": "ACCP", "canonical_uri": fmt.Sprintf("urn:accp:capacity:%d", p)}}, nil, nil))
		cp := "/contexts/" + context["id"].(string)
		v := must(c.call(token, "POST", cp+"/versions", object{"source_revision": "1", "content_uri": content["content_uri"], "content_digest": content["content_digest"], "media_type": "text/plain", "change_summary": "Capacity seed"}, 1, nil))
		must(c.call(token, "POST", cp+"/versions/"+v["id"].(string)+"/publish", object{}, 1, nil))
		f.Versions = append(f.Versions, v["id"].(string))
	}
	rows := make([][]any, 100000)
	for i := range rows {
		p := projectFor(i)
		owner := fmt.Sprintf("user_%02d", i%49)
		doc := object{"id": tid(i), "organization_id": "org_capacity", "project_id": pid(p), "title": fmt.Sprintf("Capacity task %06d", i), "objective": "Measure realistic list, input change and immutable evidence", "owner_user_id": owner, "repository_id": fmt.Sprintf("repo_%02d", p), "acceptance_criteria": []string{"Retain input and history"}, "context_version_ids": []string{f.Versions[p]}, "status": "DRAFT", "version": 1, "archived": false, "created_at": time.Now().UTC().Format(time.RFC3339Nano), "updated_at": time.Now().UTC().Format(time.RFC3339Nano)}
		raw, _ := json.Marshal(doc)
		rows[i] = []any{tid(i), pid(p), "org_capacity", owner, fmt.Sprintf("repo_%02d", p), raw, "DRAFT"}
	}
	if _, e = pool.CopyFrom(ctx, pgx.Identifier{"tasks"}, []string{"id", "project_id", "organization_id", "owner_user_id", "repository_id", "document", "status"}, pgx.CopyFromRows(rows)); e != nil {
		return e
	}
	if _, e = pool.Exec(ctx, `INSERT INTO task_contexts(task_id,context_id,version_id,project_id,organization_id) SELECT t.id,v.context_id,v.id,t.project_id,t.organization_id FROM tasks t JOIN context_versions v ON v.project_id=t.project_id`); e != nil {
		return e
	}
	if _, e = pool.Exec(ctx, `ANALYZE`); e != nil {
		return e
	}
	raw, _ := json.MarshalIndent(f, "", "  ")
	if e = os.WriteFile(path, raw, 0600); e != nil {
		return e
	}
	fmt.Println(`{"seeded_tasks":100000,"humans":50,"projects":20,"hot_project_tasks":70000}`)
	return nil
}

type sample struct {
	Kind   string
	MS     float64
	Status int
	OK     bool
}
type summary struct {
	Count  int     `json:"count"`
	P95    float64 `json:"p95_ms"`
	Errors int     `json:"errors"`
}

func summarize(samples []sample, kind string) summary {
	var values []float64
	result := summary{}
	for _, s := range samples {
		if kind != "" && s.Kind != kind {
			continue
		}
		result.Count++
		values = append(values, s.MS)
		if !s.OK {
			result.Errors++
		}
	}
	sort.Float64s(values)
	if len(values) > 0 {
		result.P95 = values[min(len(values)-1, len(values)*95/100)]
	}
	return result
}

type lease struct {
	Token string
	Run   object
}

func load(ctx context.Context, pool *pgxpool.Pool, f fixture, output, label string, smoke bool) error {
	registry, effects, e := effectRegistry(filepath.Dir(output))
	if e != nil {
		return e
	}
	server, h, c := serve(pool, f, registry)
	defer h.Close()
	workerCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	schemas, e := controlplane.NewValidator()
	if e != nil {
		return e
	}
	worker, e := eventbus.New(ctx, pool, os.Getenv("ACCP_NATS_URL"), "", "CAPACITY", schemas["M2Event"].Validate)
	if e != nil {
		return e
	}
	defer worker.Close()
	go worker.Run(workerCtx)
	policy := must(c.call(f.Credentials[0].Token, "POST", "/projects/project_00/tools", object{"backend_id": "capacity_sink", "name": "Isolated persistent effect sink", "resource_version": "1", "enabled": true, "reason": "Capacity safety verification"}, nil, nil))
	// Initialize 20 simultaneous Runs through the public authorization, assignment and claim routes.
	leases := []lease{}
	manifest := object{"adapter_id": "capacity_bridge", "adapter_version": "0.2.0", "protocol_versions": []string{"0.2"}, "client": object{"name": "capacity", "version": "1"}, "capabilities": object{"claim": true, "context_read": true, "artifact_report": true, "heartbeat": true, "cancel": "cooperative", "notifications": []string{"poll"}, "auto_start": false}}
	for i := 0; i < 20; i++ {
		token := f.Credentials[i].Token
		a := must(c.call(token, "POST", "/agents", object{"project_id": pid(0), "manifest": manifest}, nil, nil))
		grant := must(c.call(token, "POST", "/agent-sessions", object{"project_id": pid(0), "agent_id": a["id"], "scopes": []string{"tasks:read", "runs:claim", "runs:write", "context:read", "artifacts:write", "events:read", "tools:invoke"}, "expires_at": time.Now().Add(2 * time.Hour).UTC().Format(time.RFC3339)}, nil, nil))
		agentToken := grant["access_token"].(string)
		must(c.call(agentToken, "POST", "/adapters/handshake", object{"manifest": manifest}, nil, nil))
		task := must(c.call(f.Credentials[0].Token, "GET", "/tasks/"+tid(i), nil, nil, nil))
		must(c.call(f.Credentials[0].Token, "POST", "/tasks/"+tid(i)+"/assignments", object{"target": object{"agent_id": a["id"]}}, task["version"], nil))
		task = must(c.call(f.Credentials[0].Token, "GET", "/tasks/"+tid(i), nil, nil, nil))
		must(c.call(f.Credentials[0].Token, "POST", "/tasks/"+tid(i)+"/commands", object{"command": "SUBMIT", "reason": "Capacity concurrent Run"}, task["version"], nil))
		grant = must(c.call(agentToken, "POST", "/task-runs/claim", object{"project_id": pid(0), "task_id": tid(i), "base_revision": strings.Repeat("a", 40)}, nil, nil))
		run := grant["run"].(map[string]any)
		path := "/task-runs/" + run["id"].(string)
		content := must(c.call(agentToken, "POST", path+"/artifact-contents", object{"content": fmt.Sprintf("Isolated evidence for Run %d", i), "media_type": "text/plain"}, run["version"], run["fencing_token"]))
		artifact := must(c.call(agentToken, "POST", path+"/artifacts", object{"kind": "TEST_REPORT", "uri": content["uri"], "content_digest": content["content_digest"], "media_type": "text/plain"}, run["version"], run["fencing_token"]))
		inv := must(c.call(agentToken, "POST", path+"/tool-invocations", object{"tool_id": policy["id"], "resource_version": "1", "arguments": object{"value": fmt.Sprintf("effect-%02d", i)}, "artifact_ids": []any{artifact["id"]}}, run["version"], run["fencing_token"]))
		must(c.call(f.Credentials[48].Token, "POST", "/approvals/"+inv["approval_id"].(string)+"/decisions", object{"decision": "APPROVE", "binding_digest": inv["binding_digest"], "reason": "Independently approved isolated effect"}, 1, nil))
		leases = append(leases, lease{agentToken, run})
	}
	// Private drill input only: never included in reports or candidate artifacts.
	leaseData, err := json.Marshal(leases)
	if err != nil {
		return err
	}
	if err = os.WriteFile(filepath.Join(filepath.Dir(output), "active-sessions.json"), leaseData, 0600); err != nil {
		return err
	}
	var healthMu sync.Mutex
	heartbeatErrors := 0
	minActive := 20
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-workerCtx.Done():
				return
			case <-ticker.C:
			}
			for i := range leases {
				l := &leases[i]
				reply, status, err := c.call(l.Token, "POST", "/task-runs/"+l.Run["id"].(string)+"/heartbeat", object{"observed_at": time.Now().UTC().Format(time.RFC3339Nano)}, l.Run["version"], l.Run["fencing_token"])
				if err != nil || status != 200 {
					healthMu.Lock()
					heartbeatErrors++
					healthMu.Unlock()
				} else {
					if run, ok := reply["run"].(map[string]any); ok {
						l.Run = run
					} else {
						l.Run = reply
					}
				}
			}
			_ = server.Reconcile(workerCtx)
			// Repeat processing throughout load; an already executed intent must stay terminal.
			if err := server.ProcessTools(workerCtx); err != nil && workerCtx.Err() == nil {
				healthMu.Lock()
				heartbeatErrors++
				healthMu.Unlock()
			}
			var active int
			if pool.QueryRow(workerCtx, `SELECT count(*) FROM task_runs WHERE status='RUNNING'`).Scan(&active) == nil {
				healthMu.Lock()
				minActive = min(minActive, active)
				healthMu.Unlock()
			}
		}
	}()
	phases := []struct {
		Name     string
		Duration time.Duration
		RPS      int
	}{{"warmup", 5 * time.Minute, 50}, {"steady", 20 * time.Minute, 50}, {"burst", 5 * time.Minute, 100}}
	if smoke {
		phases[0].Duration = 5 * time.Second
		phases[1].Duration = 20 * time.Second
		phases[2].Duration = 5 * time.Second
	}
	report := object{"label": label, "started_at": time.Now().UTC(), "smoke_only": smoke, "resources": object{"vCPU": 8, "memory_gib": 16}, "authentication": "real development token database lookup; OIDC separately accepted", "population": object{"humans": 50, "projects": 20, "tasks": 100000, "concurrent_runs": 20, "hot_project_tasks": 70000}}
	allPassed := !smoke
	sequence := 0
	writeID := 100
	phaseReports := []object{}
	for _, phase := range phases {
		started := time.Now()
		samples := []sample{}
		var mu sync.Mutex
		var wg sync.WaitGroup
		slots := make(chan struct{}, 128)
		interval := time.Second / time.Duration(phase.RPS)
		expected := int(phase.Duration / interval)
		dropped := 0
		for arrival := 0; arrival < expected; arrival++ {
			scheduled := started.Add(time.Duration(arrival) * interval)
			if delay := time.Until(scheduled); delay > 0 {
				time.Sleep(delay)
			}
			sequence++
			n := sequence
			index := (n * 7919) % 100000
			p := projectFor(index)
			kind := "read"
			method := "GET"
			path := "/tasks/" + tid(index)
			var body any
			var version any
			token := f.Credentials[n%49].Token
			switch n % 10 {
			case 0, 1, 2, 3:
				path = fmt.Sprintf("/projects/%s/tasks?limit=25&sort=-updated&archived=false", pid(p))
			case 4, 5:
				kind = "write"
				method = "POST"
				id := 100 + (writeID*7919)%99800
				writeID++
				p = projectFor(id)
				path = "/tasks/" + tid(id) + "/changes"
				version = 1
				token = f.Credentials[id%49].Token
				body = object{"title": fmt.Sprintf("Updated %06d", id), "objective": "Capacity input correction", "acceptance_criteria": []string{"Retain audit"}, "reason": "Capacity workload"}
			case 6:
				path = "/projects/" + pid(n%20) + "/summary"
			case 7:
				kind = "authorization"
				token = f.Credentials[49].Token
				path = "/tasks/" + tid(index%70000)
			}
			select {
			case slots <- struct{}{}:
				wg.Add(1)
				go func(token, method, path, kind string, body, version any, scheduled time.Time) {
					defer wg.Done()
					defer func() { <-slots }()
					_, status, err := c.call(token, method, path, body, version, nil)
					ok := err == nil && status >= 200 && status < 300
					if kind == "authorization" {
						ok = err == nil && status == 404
					}
					s := sample{kind, float64(time.Since(scheduled).Microseconds()) / 1000, status, ok}
					mu.Lock()
					samples = append(samples, s)
					mu.Unlock()
				}(token, method, path, kind, body, version, scheduled)
			default:
				dropped++
			}
		}
		wg.Wait()
		read, write, total := summarize(samples, "read"), summarize(samples, "write"), summarize(samples, "")
		var eventP95 float64
		var pending int
		e = pool.QueryRow(ctx, `SELECT coalesce(percentile_cont(0.95) WITHIN GROUP(ORDER BY extract(epoch FROM (coalesce(f.recorded_at,now())-o.created_at))*1000),0),count(*) FILTER(WHERE f.event_id IS NULL) FROM outbox_events o LEFT JOIN event_feed f ON f.event_id=o.id WHERE o.created_at >= $1`, started).Scan(&eventP95, &pending)
		if e != nil {
			return e
		}
		errorsRate := float64(total.Errors+dropped) / float64(max(1, total.Count+dropped))
		passed := read.P95 <= 500 && write.P95 <= 1000 && errorsRate < 0.005 && eventP95 <= 5000 && dropped == 0
		if phase.Name != "warmup" {
			allPassed = allPassed && passed
		}
		entry := object{"phase": phase.Name, "duration_seconds": phase.Duration.Seconds(), "target_rps": phase.RPS, "read": read, "write": write, "authorization": summarize(samples, "authorization"), "total": total, "dropped": dropped, "error_rate": errorsRate, "event_p95_ms": eventP95, "pending_events": pending, "thresholds_pass": passed}
		phaseReports = append(phaseReports, entry)
		encoded, _ := json.Marshal(entry)
		fmt.Println(string(encoded))
		report["phases"] = phaseReports
		report["complete"] = false
		if err := writeReport(output, report); err != nil {
			return err
		}
	}
	cancel()
	<-done
	healthMu.Lock()
	report["heartbeat_errors"] = heartbeatErrors
	report["minimum_active_runs"] = minActive
	healthMu.Unlock()
	var duplicates int
	e = pool.QueryRow(ctx, `SELECT count(*) FROM (SELECT task_id FROM task_runs WHERE status='RUNNING' GROUP BY task_id HAVING count(*)>1) d`).Scan(&duplicates)
	if e != nil {
		return e
	}
	report["duplicate_active_runs"] = duplicates
	report["phases"] = phaseReports
	report["completed_at"] = time.Now().UTC()
	var completedEffects int
	if e = pool.QueryRow(ctx, `SELECT count(*) FROM tool_invocations WHERE status='SUCCEEDED'`).Scan(&completedEffects); e != nil {
		return e
	}
	calls, duplicateEffects := effects.snapshot()
	report["effect_calls"] = calls
	report["duplicate_effects"] = duplicateEffects
	report["succeeded_invocations"] = completedEffects
	report["complete"] = true
	report["passed"] = allPassed && duplicates == 0 && heartbeatErrors == 0 && minActive == 20 && calls == 20 && duplicateEffects == 0 && completedEffects == 20
	if e = writeReport(output, report); e != nil {
		return e
	}
	for _, l := range leases {
		task := must(c.call(f.Credentials[0].Token, "GET", "/tasks/"+l.Run["task_id"].(string), nil, nil, nil))
		must(c.call(f.Credentials[0].Token, "POST", "/tasks/"+task["id"].(string)+"/commands", object{"command": "CANCEL", "reason": "End isolated benchmark"}, task["version"], nil))
	}
	fmt.Printf("report=%s passed=%v\n", output, report["passed"])
	if !smoke && report["passed"] != true {
		return errors.New("capacity thresholds not met; retain actual report")
	}
	return nil
}
