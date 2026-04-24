package actions

import (
	"fmt"
	"os/exec"
	"regexp"
	"strings"
)

func init() {
	Register(&PackageHoldsListAction{})
	Register(&PackageHoldAction{})
	Register(&PackageUnholdAction{})
}

// Nom de paquet valide (conforme Debian policy)
var pkgNameRegex = regexp.MustCompile(`^[a-z0-9][a-z0-9+.\-]*$`)

// ═══════════════════════════════════════════════════════════════
// package.holds_list : apt-mark showhold
// ═══════════════════════════════════════════════════════════════

type PackageHoldsListAction struct{}

func (a *PackageHoldsListAction) ID() string                                 { return "package.holds_list" }
func (a *PackageHoldsListAction) Capability() string                         { return "monitoring" }
func (a *PackageHoldsListAction) Validate(_ map[string]interface{}) error    { return nil }

func (a *PackageHoldsListAction) Execute(_ map[string]interface{}) (interface{}, error) {
	cmd := exec.Command("sudo", "-n", "/usr/bin/apt-mark", "showhold")
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("apt-mark showhold: %w", err)
	}
	pkgs := []string{}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		line = strings.TrimSpace(line)
		if line != "" {
			pkgs = append(pkgs, line)
		}
	}
	return map[string]interface{}{
		"holds": pkgs,
		"count": len(pkgs),
	}, nil
}

// ═══════════════════════════════════════════════════════════════
// package.hold : apt-mark hold <pkg>
// ═══════════════════════════════════════════════════════════════

type PackageHoldAction struct{}

func (a *PackageHoldAction) ID() string         { return "package.hold" }
func (a *PackageHoldAction) Capability() string { return "packages" }

func (a *PackageHoldAction) Validate(params map[string]interface{}) error {
	return validatePkgName(params)
}

func (a *PackageHoldAction) Execute(params map[string]interface{}) (interface{}, error) {
	name := params["name"].(string)
	cmd := exec.Command("sudo", "-n", "/usr/bin/apt-mark", "hold", name)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("apt-mark hold failed: %s", strings.TrimSpace(string(out)))
	}
	return map[string]interface{}{
		"package": name,
		"action":  "hold",
		"output":  strings.TrimSpace(string(out)),
	}, nil
}

// ═══════════════════════════════════════════════════════════════
// package.unhold : apt-mark unhold <pkg>
// ═══════════════════════════════════════════════════════════════

type PackageUnholdAction struct{}

func (a *PackageUnholdAction) ID() string         { return "package.unhold" }
func (a *PackageUnholdAction) Capability() string { return "packages" }

func (a *PackageUnholdAction) Validate(params map[string]interface{}) error {
	return validatePkgName(params)
}

func (a *PackageUnholdAction) Execute(params map[string]interface{}) (interface{}, error) {
	name := params["name"].(string)
	cmd := exec.Command("sudo", "-n", "/usr/bin/apt-mark", "unhold", name)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("apt-mark unhold failed: %s", strings.TrimSpace(string(out)))
	}
	return map[string]interface{}{
		"package": name,
		"action":  "unhold",
		"output":  strings.TrimSpace(string(out)),
	}, nil
}

func validatePkgName(params map[string]interface{}) error {
	name, ok := params["name"].(string)
	if !ok || name == "" {
		return fmt.Errorf("required parameter 'name' missing")
	}
	if len(name) > 128 {
		return fmt.Errorf("package name too long")
	}
	if !pkgNameRegex.MatchString(name) {
		return fmt.Errorf("invalid package name")
	}
	return nil
}
