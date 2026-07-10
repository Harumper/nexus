package actions

import (
	"fmt"
	"os/exec"

	"github.com/nexus/agent/internal/collector"
)

func init() { Register(&PackageRemoveAction{}) }

type PackageRemoveAction struct{}

func (a *PackageRemoveAction) ID() string         { return "package.remove" }
func (a *PackageRemoveAction) Capability() string { return "packages" }

func (a *PackageRemoveAction) Validate(params map[string]interface{}) error {
	packages, ok := params["packages"]
	if !ok {
		return fmt.Errorf("required parameter 'packages' missing")
	}
	// Accept both string and []interface{}. Validation shared with
	// package.install (validPackageName): charset + refusal of a leading '-'.
	switch v := packages.(type) {
	case string:
		if err := validPackageName(v); err != nil {
			return err
		}
	case []interface{}:
		if len(v) == 0 {
			return fmt.Errorf("packages list cannot be empty")
		}
		for _, p := range v {
			name, ok := p.(string)
			if !ok {
				return fmt.Errorf("invalid package name")
			}
			if err := validPackageName(name); err != nil {
				return err
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

	// Remove via the compiled privhelper (root wrapper): validated names, fixed
	// argv, no NOEXEC — same rationale as package.install.
	args := append([]string{"-n", nexusAgentBin, "privhelper", "pkg", "remove"}, packageNames...)
	cmd := exec.Command("/usr/bin/sudo", args...)
	output, err := cmd.CombinedOutput()
	return map[string]interface{}{
		"success":  err == nil,
		"output":   string(output),
		"packages": packageNames,
	}, nil
}
