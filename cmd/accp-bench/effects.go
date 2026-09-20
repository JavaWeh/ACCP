package main

import (
	"context"
	"encoding/json"
	"github.com/JavaWeh/ACCP/internal/gateway"
	"os"
	"path/filepath"
	"sync"
)

type effectCounts struct {
	sync.Mutex
	calls, duplicates int
	seen              map[string]bool
}

func (e *effectCounts) snapshot() (int, int) {
	e.Lock()
	defer e.Unlock()
	return e.calls, e.duplicates
}

// The isolated sink appends every call before responding, including duplicates.
// Its receipt file lives outside PostgreSQL so restore cannot rewrite evidence.
func effectRegistry(directory string) (*gateway.Registry, *effectCounts, error) {
	config := []object{{"id": "capacity_sink", "project_id": "project_00", "resource_id": "capacity_sink", "kind": "mcp", "version": "1", "endpoint": "http://127.0.0.1:9999/mcp", "tool_name": "write", "read_only": false, "input_schema": object{"type": "object", "properties": object{"value": object{"type": "string"}}, "required": []string{"value"}, "additionalProperties": false}}}
	raw, _ := json.Marshal(config)
	path := filepath.Join(directory, "sink-config.json")
	if err := os.WriteFile(path, raw, 0600); err != nil {
		return nil, nil, err
	}
	registry, err := gateway.Load(path, true)
	if err != nil {
		return nil, nil, err
	}
	counts := &effectCounts{seen: map[string]bool{}}
	receipts := filepath.Join(directory, "effect-receipts.ndjson")
	initial, err := os.OpenFile(receipts, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return nil, nil, err
	}
	initial.Close()
	registry.ExecuteOverride = func(_ context.Context, _ *gateway.Backend, args map[string]any, operation, resource string) (map[string]any, error) {
		counts.Lock()
		defer counts.Unlock()
		file, err := os.OpenFile(receipts, os.O_APPEND|os.O_WRONLY, 0600)
		if err != nil {
			return nil, err
		}
		defer file.Close()
		if err = json.NewEncoder(file).Encode(object{"operation_id": operation, "resource_version": resource, "arguments": args}); err != nil {
			return nil, err
		}
		if err = file.Sync(); err != nil {
			return nil, err
		}
		counts.calls++
		if counts.seen[operation] {
			counts.duplicates++
		}
		counts.seen[operation] = true
		return object{"state": "SUCCEEDED", "operation_id": operation}, nil
	}
	return registry, counts, nil
}
func writeReport(path string, report object) error {
	raw, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, raw, 0600)
}
