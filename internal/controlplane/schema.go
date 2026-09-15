package controlplane

import (
	"encoding/json"
	"fmt"

	"github.com/JavaWeh/ACCP/contracts"
	"github.com/santhosh-tekuri/jsonschema/v6"
)

type Validator map[string]*jsonschema.Schema

func NewValidator() (Validator, error) {
	compiler := jsonschema.NewCompiler()
	compiler.AssertFormat()
	entries, err := contracts.Schemas.ReadDir("schemas")
	if err != nil {
		return nil, err
	}
	for _, entry := range entries {
		data, err := contracts.Schemas.ReadFile("schemas/" + entry.Name())
		if err != nil {
			return nil, err
		}
		var doc map[string]any
		if err = json.Unmarshal(data, &doc); err != nil {
			return nil, err
		}
		if err = compiler.AddResource(doc["$id"].(string), doc); err != nil {
			return nil, err
		}
	}
	result := Validator{}
	for file, names := range map[string][]string{
		"domain": {"CreateTask", "TaskCommand", "CreateContext", "CreateContextVersion", "Task", "Context", "ContextVersion", "Repository", "Problem", "TaskPage", "ContextPage", "RepositoryPage", "AuditRecord", "AuditPage"},
		"m1":     {"UploadContent", "MembershipChange", "Human", "ProjectPage", "Membership", "MembershipPage", "ContentMetadata", "Content", "ContextVersionPage"},
	} {
		for _, name := range names {
			s, err := compiler.Compile(fmt.Sprintf("https://accp.example/schemas/v0.1/%s.schema.json#/$defs/%s", file, name))
			if err != nil {
				return nil, err
			}
			result[name] = s
		}
	}
	event, err := compiler.Compile("https://accp.example/schemas/v0.1/event.schema.json")
	if err != nil {
		return nil, err
	}
	result["Event"] = event
	for file, names := range map[string][]string{
		"domain": {"AgentIdentity", "AgentSession", "CreateSession", "SessionGrant", "Reason", "CreateAssignment", "Assignment", "CreateDependency", "TaskDependency", "TaskRun", "ContextSnapshot", "ClaimResponse", "HeartbeatRequest", "HeartbeatResponse", "RunReport", "RegisterArtifact", "Artifact"},
		"m2":     {"AgentRegistration", "HandshakeRequest", "HandshakeResponse", "ClaimRequest", "Event", "EventPage", "ArtifactContent", "RunReportPage"},
	} {
		version := "0.1"
		if file == "m2" {
			version = "0.2"
		}
		for _, name := range names {
			s, err := compiler.Compile(fmt.Sprintf("https://accp.example/schemas/v%s/%s.schema.json#/$defs/%s", version, file, name))
			if err != nil {
				return nil, err
			}
			result["M2"+name] = s
		}
	}
	for _, name := range []string{"Reason", "ArtifactReview", "TaskReview", "PolicyRequest", "InvocationRequest", "ApprovalDecision", "Invocation", "Approval", "Artifact", "GatewayGrant", "Policy", "PolicyPage", "InvocationPage", "ApprovalPage"} {
		s, err := compiler.Compile("https://accp.example/schemas/v0.3/m3.schema.json#/$defs/" + name)
		if err != nil {
			return nil, err
		}
		result["M3"+name] = s
	}
	return result, nil
}
