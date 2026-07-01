package actions

import (
	"github.com/nexus/agent/internal/collector"
)

func init() { Register(&ProcessListAction{}) }

type ProcessListAction struct{}

func (a *ProcessListAction) ID() string         { return "system.processes" }
func (a *ProcessListAction) Capability() string { return "monitoring" }

func (a *ProcessListAction) Validate(params map[string]interface{}) error {
	return nil
}

func (a *ProcessListAction) Execute(params map[string]interface{}) (interface{}, error) {
	procPath := "/proc"
	if p, ok := params["proc_path"].(string); ok && p != "" {
		procPath = p
	}

	result, err := collector.GetTopProcesses(procPath, 10)
	if err != nil {
		return nil, err
	}

	return result, nil
}
