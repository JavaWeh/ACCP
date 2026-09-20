package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"

	"github.com/JavaWeh/ACCP/internal/bridge"
	"github.com/JavaWeh/ACCP/internal/buildinfo"
	"github.com/JavaWeh/ACCP/pkg/client"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func run() error {
	if len(os.Args) == 2 && os.Args[1] == "--version" {
		return buildinfo.Write(os.Stdout)
	}
	c, err := client.New(os.Getenv("ACCP_URL"), os.Getenv("ACCP_SESSION_TOKEN"))
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	raw, err := os.ReadFile(os.Getenv("ACCP_ADAPTER_MANIFEST"))
	if err != nil || len(raw) > 65536 {
		return errors.New("provide a bounded ACCP_ADAPTER_MANIFEST JSON file")
	}
	var manifest client.Object
	if json.Unmarshal(raw, &manifest) != nil {
		return errors.New("invalid adapter manifest")
	}
	if _, err = c.Call(ctx, "POST", "/adapters/handshake", client.Object{"manifest": manifest}, client.WriteOptions{IdempotencyKey: client.NewKey()}); err != nil {
		return err
	}
	if len(os.Args) == 1 || len(os.Args) == 2 && os.Args[1] == "stdio" {
		return bridge.NewWithAutoHeartbeat(c).Run(ctx, &mcp.StdioTransport{})
	}
	// CLI mode uses the same MCP tool definitions through an in-memory transport,
	// avoiding a second implementation of protocol behavior.
	if len(os.Args) != 3 || os.Args[1] != "call" {
		return errors.New("usage: accp-bridge [stdio | call TOOL < input.json]")
	}
	raw, err = io.ReadAll(io.LimitReader(os.Stdin, 1024*1024+1))
	if err != nil || len(raw) > 1024*1024 {
		return errors.New("invalid tool input")
	}
	var input map[string]any
	if json.Unmarshal(raw, &input) != nil {
		return errors.New("invalid tool input JSON")
	}
	serverTransport, clientTransport := mcp.NewInMemoryTransports()
	serverSession, err := bridge.New(c).Connect(ctx, serverTransport, nil)
	if err != nil {
		return err
	}
	defer serverSession.Close()
	session, err := mcp.NewClient(&mcp.Implementation{Name: "accp-cli", Version: "0.2.0"}, nil).Connect(ctx, clientTransport, nil)
	if err != nil {
		return err
	}
	defer session.Close()
	res, err := session.CallTool(ctx, &mcp.CallToolParams{Name: os.Args[2], Arguments: input})
	if err != nil {
		return err
	}
	if err = json.NewEncoder(os.Stdout).Encode(res); err != nil {
		return err
	}
	if res.IsError {
		return errors.New("ACCP tool failed")
	}
	return nil
}
