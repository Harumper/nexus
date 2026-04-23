package actions

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"time"
)

func init() { Register(&ScriptExecuteAction{}) }

type ScriptExecuteAction struct{}

func (a *ScriptExecuteAction) ID() string        { return "script.execute" }
func (a *ScriptExecuteAction) Capability() string { return "scripts" }

func (a *ScriptExecuteAction) Validate(params map[string]interface{}) error {
	script, ok := params["script"].(string)
	if !ok || script == "" {
		return fmt.Errorf("required parameter 'script' missing")
	}
	if len(script) > 10240 {
		return fmt.Errorf("script too large (max 10 KB)")
	}
	return nil
}

func (a *ScriptExecuteAction) Execute(params map[string]interface{}) (interface{}, error) {
	script := params["script"].(string)

	timeoutSec := 30
	if t, ok := params["timeout"].(float64); ok && t > 0 {
		timeoutSec = int(t)
	}
	if timeoutSec > 300 {
		timeoutSec = 300 // Max 5 minutes
	}

	// Write script to dedicated state directory (not world-writable /tmp)
	// Created by systemd via StateDirectory=nexus-agent
	scriptDir := "/var/lib/nexus-agent"
	os.MkdirAll(scriptDir, 0700)
	tmpFile, err := os.CreateTemp(scriptDir, "nexus-script-*.sh")
	if err != nil {
		return nil, fmt.Errorf("failed to create temp file: %w", err)
	}
	defer os.Remove(tmpFile.Name())

	if _, err := tmpFile.WriteString("#!/bin/bash\nset -e\n" + script); err != nil {
		tmpFile.Close()
		return nil, fmt.Errorf("failed to write script: %w", err)
	}
	tmpFile.Close()

	if err := os.Chmod(tmpFile.Name(), 0700); err != nil {
		return nil, fmt.Errorf("failed to chmod script: %w", err)
	}

	// Execute with timeout
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutSec)*time.Second)
	defer cancel()

	// Via sudo — l'agent tourne sous nexus-agent (non-root)
	cmd := exec.CommandContext(ctx, "/usr/bin/sudo", "/bin/bash", tmpFile.Name())
	output, err := cmd.CombinedOutput()

	exitCode := 0
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			exitCode = exitErr.ExitCode()
		} else {
			exitCode = -1
		}
	}

	return map[string]interface{}{
		"success":   err == nil,
		"output":    string(output),
		"exit_code": exitCode,
	}, nil
}
