package collector

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// GetCPU reads /proc/stat twice 1s apart to compute the CPU %
func GetCPU(procPath string) (float64, error) {
	idle1, total1, err := readCPUStat(procPath)
	if err != nil {
		return 0, err
	}

	time.Sleep(1 * time.Second)

	idle2, total2, err := readCPUStat(procPath)
	if err != nil {
		return 0, err
	}

	idleDelta := float64(idle2 - idle1)
	totalDelta := float64(total2 - total1)

	if totalDelta == 0 {
		return 0, nil
	}

	cpuPercent := (1.0 - idleDelta/totalDelta) * 100.0
	return cpuPercent, nil
}

func readCPUStat(procPath string) (idle, total uint64, err error) {
	data, err := os.ReadFile(filepath.Join(procPath, "stat"))
	if err != nil {
		return 0, 0, fmt.Errorf("failed to read /proc/stat: %w", err)
	}

	lines := strings.Split(string(data), "\n")
	for _, line := range lines {
		if strings.HasPrefix(line, "cpu ") {
			fields := strings.Fields(line)
			if len(fields) < 5 {
				return 0, 0, fmt.Errorf("unexpected /proc/stat format")
			}

			var values []uint64
			for _, f := range fields[1:] {
				v, err := strconv.ParseUint(f, 10, 64)
				if err != nil {
					continue
				}
				values = append(values, v)
			}

			if len(values) < 4 {
				return 0, 0, fmt.Errorf("not enough CPU fields")
			}

			for _, v := range values {
				total += v
			}
			idle = values[3] // 4th field is idle
			return idle, total, nil
		}
	}

	return 0, 0, fmt.Errorf("cpu line not found in /proc/stat")
}
