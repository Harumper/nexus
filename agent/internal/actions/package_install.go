package actions

import (
	"fmt"
	"os/exec"

	"github.com/nexus/agent/internal/collector"
)

func init() { Register(&PackageInstallAction{}) }

type PackageInstallAction struct{}

func (a *PackageInstallAction) ID() string         { return "package.install" }
func (a *PackageInstallAction) Capability() string { return "packages" }

// validPackageName validates an apt package name. Restricted charset + refusal of
// a leading '-' (otherwise "-oDPkg::Pre-Invoke::=<cmd>" would pass to apt-get: only
// the sudoers NOEXEC tag prevented it, which violated the "barrier on the Go side" rule).
// Shared by package.install AND package.remove.
func validPackageName(name string) error {
	if name == "" {
		return fmt.Errorf("invalid package name")
	}
	if name[0] == '-' {
		return fmt.Errorf("invalid package name (option-like): %s", name)
	}
	for _, c := range name {
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '.' || c == '+' || c == ':') {
			return fmt.Errorf("invalid character in package name: %c", c)
		}
	}
	return nil
}

func (a *PackageInstallAction) Validate(params map[string]interface{}) error {
	packages, ok := params["packages"]
	if !ok {
		return fmt.Errorf("required parameter 'packages' missing")
	}
	// Accept both string and []interface{}
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

func (a *PackageInstallAction) Execute(params map[string]interface{}) (interface{}, error) {
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

	// Install via the compiled privhelper (root wrapper): names are re-validated
	// and the argv is fixed inside it, so no apt/dnf/yum option can be injected —
	// and it execs the manager WITHOUT NOEXEC, so downloads + dpkg/rpm work.
	args := append([]string{"-n", nexusAgentBin, "privhelper", "pkg", "install"}, packageNames...)
	cmd := exec.Command("/usr/bin/sudo", args...)
	output, err := cmd.CombinedOutput()
	return map[string]interface{}{
		"success":  err == nil,
		"output":   string(output),
		"packages": packageNames,
	}, nil
}
