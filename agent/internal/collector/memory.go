package collector

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type MemoryInfo struct {
	Total   uint64  `json:"total"`
	Used    uint64  `json:"used"`
	Free    uint64  `json:"free"`
	Available uint64 `json:"available"`
	Percent float64 `json:"percent"`
}

// GetMemory lit /proc/meminfo
func GetMemory(procPath string) (*MemoryInfo, error) {
	data, err := os.ReadFile(filepath.Join(procPath, "meminfo"))
	if err != nil {
		return nil, fmt.Errorf("failed to read /proc/meminfo: %w", err)
	}

	info := &MemoryInfo{}
	values := make(map[string]uint64)

	for _, line := range strings.Split(string(data), "\n") {
		parts := strings.Fields(line)
		if len(parts) < 2 {
			continue
		}
		key := strings.TrimSuffix(parts[0], ":")
		val, err := strconv.ParseUint(parts[1], 10, 64)
		if err != nil {
			continue
		}
		// Les valeurs dans /proc/meminfo sont en kB
		values[key] = val * 1024
	}

	info.Total = values["MemTotal"]
	info.Free = values["MemFree"]
	info.Available = values["MemAvailable"]

	if info.Available > 0 {
		info.Used = info.Total - info.Available
	} else {
		info.Used = info.Total - info.Free
	}

	if info.Total > 0 {
		info.Percent = float64(info.Used) / float64(info.Total) * 100.0
	}

	return info, nil
}
