package actions

import (
	"fmt"
	"os/exec"

	"github.com/nexus/agent/internal/collector"
)

func init() { Register(&PackageRemoveAction{}) }

type PackageRemoveAction struct{}

func (a *PackageRemoveAction) ID() string        { return "package.remove" }
func (a *PackageRemoveAction) Capability() string { return "packages" }

func (a *PackageRemoveAction) Validate(params map[string]interface{}) error {
	packages, ok := params["packages"]
	if !ok {
		return fmt.Errorf("required parameter 'packages' missing")
	}
	// Accept both string and []interface{}
	switch v := packages.(type) {
	case string:
		if v == "" {
			return fmt.Errorf("packages cannot be empty")
		}
	case []interface{}:
		if len(v) == 0 {
			return fmt.Errorf("packages list cannot be empty")
		}
		for _, p := range v {
			name, ok := p.(string)
			if !ok || name == "" {
				return fmt.Errorf("invalid package name")
			}
			// Basic injection prevention - only allow alphanumeric, dash, dot, plus
			for _, c := range name {
				if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '.' || c == '+' || c == ':') {
					return fmt.Errorf("invalid character in package name: %c", c)
				}
			}
		}
	default:
		return fmt.Errorf("'packages' must be a string or array of strings")
	}
	return nil
}

func (a *PackageRemoveAction) Execute(params map[string]interface{}) (interface{}, error) {
	pm := collector.DetectPackageManager()
	if pm == collector.PMUnknown {
		return nil, fmt.Errorf("no supported package manager found")
	}

	// Extract package names
	var packageNames []string
	switch v := params["packages"].(type) {
	case string:
		packageNames = []string{v}
	case []interface{}:
		for _, p := range v {
			packageNames = append(packageNames, p.(string))
		}
	}

	var cmd *exec.Cmd
	switch pm {
	case collector.PMApt:
		args := append([]string{"/usr/bin/apt-get", "remove", "-y", "-qq"}, packageNames...)
		cmd = exec.Command("/usr/bin/sudo", args...)
		cmd.Env = append(cmd.Environ(), "DEBIAN_FRONTEND=noninteractive")
	case collector.PMDnf:
		args := append([]string{"/usr/bin/dnf", "remove", "-y", "-q"}, packageNames...)
		cmd = exec.Command("/usr/bin/sudo", args...)
	case collector.PMYum:
		args := append([]string{"/usr/bin/yum", "remove", "-y", "-q"}, packageNames...)
		cmd = exec.Command("/usr/bin/sudo", args...)
	default:
		return nil, fmt.Errorf("unsupported package manager: %s", pm)
	}

	output, err := cmd.CombinedOutput()
	return map[string]interface{}{
		"success":  err == nil,
		"output":   string(output),
		"packages": packageNames,
	}, nil
}
