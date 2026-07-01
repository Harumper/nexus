package actions

import (
	"github.com/nexus/agent/internal/collector"
)

func init() { Register(&HeartbeatAction{}) }

type HeartbeatAction struct{}

func (a *HeartbeatAction) ID() string         { return "system.heartbeat" }
func (a *HeartbeatAction) Capability() string { return "monitoring" }

func (a *HeartbeatAction) Validate(params map[string]interface{}) error {
	return nil
}

func (a *HeartbeatAction) Execute(params map[string]interface{}) (interface{}, error) {
	uptime, err := collector.GetUptime("")
	if err != nil {
		return nil, err
	}
	return map[string]interface{}{
		"uptime": uptime,
	}, nil
}
