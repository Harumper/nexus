package actions

import (
	"fmt"

	"github.com/nexus/agent/internal/collector"
)

func init() { Register(&PackageListAction{}) }

type PackageListAction struct{}

func (a *PackageListAction) ID() string         { return "system.package_list" }
func (a *PackageListAction) Capability() string { return "updates" }

func (a *PackageListAction) Validate(params map[string]interface{}) error {
	return nil
}

func (a *PackageListAction) Execute(params map[string]interface{}) (interface{}, error) {
	pm := collector.DetectPackageManager()
	if pm == collector.PMUnknown {
		return nil, fmt.Errorf("no supported package manager found")
	}

	updates, err := collector.ListPendingUpdates(pm)
	if err != nil {
		return nil, fmt.Errorf("failed to list pending updates: %w", err)
	}

	securityCount := 0
	deferredCount := 0
	for _, u := range updates {
		if u.SecurityUpdate {
			securityCount++
		}
		if u.Deferred {
			deferredCount++
		}
	}

	return map[string]interface{}{
		"package_manager":  string(pm),
		"total_updates":    len(updates),
		"security_updates": securityCount,
		// Deferred packages (phased/kept-back): listed but not installed
		// immediately by `apt-get upgrade`. Explains the discrepancy with the MOTD.
		"deferred_updates": deferredCount,
		"packages":         updates,
	}, nil
}
