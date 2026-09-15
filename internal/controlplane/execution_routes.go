package controlplane

func (s *Server) extendRoutes(routes map[string]operation) {
	for pattern, scope := range map[string]string{
		"GET /api/v1/projects/{id}/tasks": "tasks:read", "GET /api/v1/tasks/{id}": "tasks:read",
		"GET /api/v1/projects/{id}/contexts": "context:read", "GET /api/v1/contexts/{id}": "context:read",
		"GET /api/v1/contexts/{id}/versions": "context:read", "GET /api/v1/contexts/{id}/versions/{version}": "context:read", "GET /api/v1/contents/{id}": "context:read",
	} {
		op := routes[pattern]
		op.scope = scope
		routes[pattern] = op
	}
	additions := map[string]operation{
		"POST /api/v1/agents":                                      {schema: "M2AgentRegistration", role: "MEMBER", bodyProject: true, run: registerAgent},
		"GET /api/v1/projects/{id}/agents":                         {table: "projects", run: listResources("agents", "")},
		"POST /api/v1/agent-sessions":                              {schema: "M2CreateSession", role: "MEMBER", bodyProject: true, grant: true, run: createSession},
		"GET /api/v1/agent-sessions/{id}":                          {table: "agent_sessions", run: getSession},
		"POST /api/v1/agent-sessions/{id}/revoke":                  {table: "agent_sessions", schema: "M2Reason", conditional: true, run: revokeSession},
		"POST /api/v1/adapters/handshake":                          {schema: "M2HandshakeRequest", scope: "handshake", agentOnly: true, run: handshake},
		"POST /api/v1/tasks/{id}/assignments":                      {table: "tasks", schema: "M2CreateAssignment", conditional: true, run: assignTask},
		"GET /api/v1/tasks/{id}/assignments":                       {table: "tasks", run: listResources("assignments", "task_id")},
		"POST /api/v1/tasks/{id}/dependencies":                     {table: "tasks", schema: "M2CreateDependency", conditional: true, run: addDependency},
		"GET /api/v1/tasks/{id}/dependencies":                      {table: "tasks", scope: "tasks:read", run: listResources("task_dependencies", "successor_task_id")},
		"POST /api/v1/tasks/{id}/dependencies/{dependency}/remove": {table: "tasks", schema: "M2Reason", conditional: true, run: removeDependency},
		"POST /api/v1/task-runs/claim":                             {schema: "M2ClaimRequest", scope: "runs:claim", agentOnly: true, bodyProject: true, run: claimRun},
		"GET /api/v1/task-runs/{id}":                               {table: "task_runs", scope: "tasks:read", run: getRun},
		"GET /api/v1/tasks/{id}/runs":                              {table: "tasks", run: listResources("task_runs", "task_id")},
		"POST /api/v1/task-runs/{id}/heartbeat":                    {table: "task_runs", schema: "M2HeartbeatRequest", scope: "runs:write", agentOnly: true, conditional: true, fenced: true, run: heartbeatRun},
		"POST /api/v1/task-runs/{id}/reports":                      {table: "task_runs", schema: "M2RunReport", scope: "runs:write", agentOnly: true, conditional: true, fenced: true, run: reportRun},
		"GET /api/v1/context-snapshots/{id}":                       {table: "context_snapshots", scope: "context:read", run: getSnapshot},
		"POST /api/v1/task-runs/{id}/artifact-contents":            {table: "task_runs", schema: "UploadContent", scope: "artifacts:write", agentOnly: true, conditional: true, fenced: true, run: uploadArtifactContent},
		"POST /api/v1/task-runs/{id}/artifacts":                    {table: "task_runs", schema: "M2RegisterArtifact", scope: "artifacts:write", agentOnly: true, conditional: true, fenced: true, run: registerArtifact},
		"GET /api/v1/artifacts/{id}":                               {table: "artifacts", scope: "tasks:read", run: getArtifact},
		"GET /api/v1/artifact-contents/{id}":                       {table: "artifact_contents", scope: "tasks:read", run: getArtifactContent},
		"GET /api/v1/events":                                       {scope: "events:read", queryProject: true, run: pollEvents},
		"POST /api/v1/projects/{id}/events/{event}/replay":         {table: "projects", schema: "M2Reason", role: "ADMIN", run: replayEvent},
	}
	additions["GET /api/v1/task-runs/{id}/reports"] = operation{table: "task_runs", scope: "tasks:read", run: listRunReports}
	for pattern, op := range additions {
		routes[pattern] = op
	}
}
