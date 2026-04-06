package actions

import (
	"github.com/nexus/agent/internal/collector"
)

func init() { Register(&SystemInfoAction{}) }

type SystemInfoAction struct {
	ProcPath string
}

func (a *SystemInfoAction) ID() string         { return "system.info" }
func (a *SystemInfoAction) Capability() string  { return "monitoring" }

func (a *SystemInfoAction) Validate(params map[string]interface{}) error {
	return nil
}

func (a *SystemInfoAction) Execute(params map[string]interface{}) (interface{}, error) {
	return collector.GetSystemInfo(a.ProcPath)
}
