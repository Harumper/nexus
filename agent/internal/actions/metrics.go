package actions

import (
	"github.com/nexus/agent/internal/collector"
)

func init() { Register(&MetricsAction{}) }

type MetricsAction struct {
	ProcPath string
}

func (a *MetricsAction) ID() string         { return "system.metrics" }
func (a *MetricsAction) Capability() string  { return "monitoring" }

func (a *MetricsAction) Validate(params map[string]interface{}) error {
	return nil
}

func (a *MetricsAction) Execute(params map[string]interface{}) (interface{}, error) {
	procPath := a.ProcPath
	if procPath == "" {
		procPath = "/proc"
	}

	cpu, err := collector.GetCPU(procPath)
	if err != nil {
		return nil, err
	}

	mem, err := collector.GetMemory(procPath)
	if err != nil {
		return nil, err
	}

	disks, err := collector.GetDisks(procPath)
	if err != nil {
		return nil, err
	}

	loadAvg, err := collector.GetLoadAvg(procPath)
	if err != nil {
		loadAvg = &collector.LoadAvg{}
	}

	uptime, err := collector.GetUptime(procPath)
	if err != nil {
		uptime = 0
	}

	return map[string]interface{}{
		"cpu_percent":    cpu,
		"memory_used":   mem.Used,
		"memory_total":  mem.Total,
		"memory_percent": mem.Percent,
		"disks":         disks,
		"load_avg_1":    loadAvg.Avg1,
		"load_avg_5":    loadAvg.Avg5,
		"load_avg_15":   loadAvg.Avg15,
		"uptime":        uptime,
	}, nil
}
