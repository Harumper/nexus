package collector

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

type DiskInfo struct {
	Mountpoint string  `json:"mountpoint"`
	Filesystem string  `json:"filesystem"`
	Total      uint64  `json:"total"`
	Used       uint64  `json:"used"`
	Free       uint64  `json:"free"`
	Percent    float64 `json:"percent"`
}

// GetDisks lit /proc/mounts et utilise syscall.Statfs
func GetDisks(procPath string) ([]DiskInfo, error) {
	data, err := os.ReadFile(filepath.Join(procPath, "mounts"))
	if err != nil {
		return nil, fmt.Errorf("failed to read /proc/mounts: %w", err)
	}

	var disks []DiskInfo
	seen := make(map[string]bool)

	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}

		device := fields[0]
		mountpoint := fields[1]
		fstype := fields[2]

		// Ignorer les systèmes de fichiers virtuels
		if isVirtualFS(fstype) {
			continue
		}

		// Ignorer les doublons (même device)
		if seen[device] {
			continue
		}
		seen[device] = true

		var stat syscall.Statfs_t
		if err := syscall.Statfs(mountpoint, &stat); err != nil {
			continue
		}

		total := stat.Blocks * uint64(stat.Bsize)
		free := stat.Bfree * uint64(stat.Bsize)
		used := total - free

		var percent float64
		if total > 0 {
			percent = float64(used) / float64(total) * 100.0
		}

		disks = append(disks, DiskInfo{
			Mountpoint: mountpoint,
			Filesystem: fstype,
			Total:      total,
			Used:       used,
			Free:       free,
			Percent:    percent,
		})
	}

	return disks, nil
}

func isVirtualFS(fstype string) bool {
	virtual := map[string]bool{
		"sysfs": true, "proc": true, "tmpfs": true, "devtmpfs": true,
		"devpts": true, "cgroup": true, "cgroup2": true, "pstore": true,
		"securityfs": true, "debugfs": true, "tracefs": true, "fusectl": true,
		"configfs": true, "hugetlbfs": true, "mqueue": true, "binfmt_misc": true,
		"autofs": true, "overlay": true, "nsfs": true, "squashfs": true,
	}
	return virtual[fstype]
}
