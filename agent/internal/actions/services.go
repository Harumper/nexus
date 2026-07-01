package actions

import (
	"encoding/json"
	"fmt"
	"os/exec"
	"regexp"
	"strings"
)

func init() {
	Register(&ServicesListAction{})
	Register(&ServiceStatusAction{})
	Register(&ServiceStartAction{})
	Register(&ServiceStopAction{})
	Register(&ServiceRestartAction{})
}

// Valid service name: letters, digits, @, _, ., - with optional .service suffix
var serviceNameRegex = regexp.MustCompile(`^[a-zA-Z0-9@_.\-]+(\.service)?$`)

// Service we absolutely refuse to stop/restart (the agent itself)
const protectedService = "nexus-agent"

func validateServiceName(params map[string]interface{}) (string, error) {
	raw, ok := params["service"].(string)
	if !ok || raw == "" {
		return "", fmt.Errorf("required parameter 'service' missing or not a string")
	}
	if len(raw) > 128 {
		return "", fmt.Errorf("service name too long (max 128)")
	}
	if !serviceNameRegex.MatchString(raw) {
		return "", fmt.Errorf("invalid service name: only [a-zA-Z0-9@_.-] allowed")
	}
	return raw, nil
}

func isProtectedService(name string) bool {
	return strings.TrimSuffix(name, ".service") == protectedService
}

// ===================== services_list =====================

type ServicesListAction struct{}

func (a *ServicesListAction) ID() string         { return "system.services_list" }
func (a *ServicesListAction) Capability() string { return "system_control" }
func (a *ServicesListAction) Validate(params map[string]interface{}) error {
	return nil
}
func (a *ServicesListAction) Execute(params map[string]interface{}) (interface{}, error) {
	// Read-only, no sudo. JSON output via -o json.
	cmd := exec.Command("/usr/bin/systemctl", "list-units", "--type=service", "--all", "--no-pager", "-o", "json")
	output, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("list-units failed: %w", err)
	}

	var units []map[string]interface{}
	if err := json.Unmarshal(output, &units); err != nil {
		return nil, fmt.Errorf("parse JSON: %w", err)
	}

	return map[string]interface{}{
		"services": units,
		"count":    len(units),
	}, nil
}

// ===================== service_status =====================

type ServiceStatusAction struct{}

func (a *ServiceStatusAction) ID() string         { return "system.service_status" }
func (a *ServiceStatusAction) Capability() string { return "system_control" }
func (a *ServiceStatusAction) Validate(params map[string]interface{}) error {
	_, err := validateServiceName(params)
	return err
}
func (a *ServiceStatusAction) Execute(params map[string]interface{}) (interface{}, error) {
	name, _ := validateServiceName(params)
	// No sudo for status (read)
	cmd := exec.Command("/usr/bin/systemctl", "status", name, "--no-pager")
	output, _ := cmd.CombinedOutput()
	// systemctl status returns exit 3 when the service is inactive, but we want the text anyway
	return map[string]interface{}{
		"service": name,
		"output":  string(output),
	}, nil
}

// ===================== service_start =====================

type ServiceStartAction struct{}

func (a *ServiceStartAction) ID() string         { return "system.service_start" }
func (a *ServiceStartAction) Capability() string { return "system_control" }
func (a *ServiceStartAction) Validate(params map[string]interface{}) error {
	_, err := validateServiceName(params)
	return err
}
func (a *ServiceStartAction) Execute(params map[string]interface{}) (interface{}, error) {
	name, _ := validateServiceName(params)
	cmd := exec.Command("/usr/bin/sudo", "-n", nexusAgentBin, "privhelper", "svc", "start", name)
	output, err := cmd.CombinedOutput()
	return map[string]interface{}{
		"service": name,
		"success": err == nil,
		"output":  string(output),
	}, nil
}

// ===================== service_stop =====================

type ServiceStopAction struct{}

func (a *ServiceStopAction) ID() string         { return "system.service_stop" }
func (a *ServiceStopAction) Capability() string { return "system_control" }
func (a *ServiceStopAction) Validate(params map[string]interface{}) error {
	name, err := validateServiceName(params)
	if err != nil {
		return err
	}
	if isProtectedService(name) {
		return fmt.Errorf("refusing to stop protected service %s", name)
	}
	return nil
}
func (a *ServiceStopAction) Execute(params map[string]interface{}) (interface{}, error) {
	name, _ := validateServiceName(params)
	cmd := exec.Command("/usr/bin/sudo", "-n", nexusAgentBin, "privhelper", "svc", "stop", name)
	output, err := cmd.CombinedOutput()
	return map[string]interface{}{
		"service": name,
		"success": err == nil,
		"output":  string(output),
	}, nil
}

// ===================== service_restart =====================

type ServiceRestartAction struct{}

func (a *ServiceRestartAction) ID() string         { return "system.service_restart" }
func (a *ServiceRestartAction) Capability() string { return "system_control" }
func (a *ServiceRestartAction) Validate(params map[string]interface{}) error {
	name, err := validateServiceName(params)
	if err != nil {
		return err
	}
	if isProtectedService(name) {
		return fmt.Errorf("refusing to restart protected service %s (use UI upgrade instead)", name)
	}
	return nil
}
func (a *ServiceRestartAction) Execute(params map[string]interface{}) (interface{}, error) {
	name, _ := validateServiceName(params)
	cmd := exec.Command("/usr/bin/sudo", "-n", nexusAgentBin, "privhelper", "svc", "restart", name)
	output, err := cmd.CombinedOutput()
	return map[string]interface{}{
		"service": name,
		"success": err == nil,
		"output":  string(output),
	}, nil
}
