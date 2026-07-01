package collector

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

type SystemInfo struct {
	OS        string   `json:"os"`
	OSVersion string   `json:"os_version"`
	Hostname  string   `json:"hostname"`
	Arch      string   `json:"arch"`
	Kernel    string   `json:"kernel"`
	IPs       []string `json:"ips,omitempty"`
}

type NetInterface struct {
	Name string `json:"name"`
	IP   string `json:"ip"`
}

type LoadAvg struct {
	Avg1  float64 `json:"avg1"`
	Avg5  float64 `json:"avg5"`
	Avg15 float64 `json:"avg15"`
}

// GetSystemInfo collects system information
func GetSystemInfo(procPath string) (*SystemInfo, error) {
	if procPath == "" {
		procPath = "/proc"
	}

	info := &SystemInfo{
		Arch: runtime.GOARCH,
	}

	// Hostname — priority: env var > host's /proc > os.Hostname()
	if envHost := os.Getenv("NEXUS_HOSTNAME"); envHost != "" {
		info.Hostname = envHost
	} else if hostHostname, err := os.ReadFile(filepath.Join(procPath, "sys/kernel/hostname")); err == nil {
		info.Hostname = strings.TrimSpace(string(hostHostname))
	} else if hostname, err := os.Hostname(); err == nil {
		info.Hostname = hostname
	}

	// OS info from /etc/os-release (or /host/etc/os-release in Docker)
	osRelease := readOSRelease()
	info.OS = osRelease["ID"]
	info.OSVersion = osRelease["VERSION_ID"]
	if info.OS == "" {
		info.OS = runtime.GOOS
	}

	// Kernel version from /proc/version
	kernelData, err := os.ReadFile(filepath.Join(procPath, "version"))
	if err == nil {
		parts := strings.Fields(string(kernelData))
		if len(parts) >= 3 {
			info.Kernel = parts[2]
		}
	}

	// IPs — priority: env var > /proc/net/fib_trie
	if envIPs := os.Getenv("NEXUS_HOST_IPS"); envIPs != "" {
		for _, ip := range strings.Split(envIPs, ",") {
			ip = strings.TrimSpace(ip)
			if ip != "" {
				info.IPs = append(info.IPs, ip)
			}
		}
	} else {
		info.IPs = getHostIPs(procPath)
	}

	return info, nil
}

// getHostIPs reads the IPv4 addresses from /proc/net/fib_trie
func getHostIPs(procPath string) []string {
	data, err := os.ReadFile(filepath.Join(procPath, "net/fib_trie"))
	if err != nil {
		return nil
	}

	var ips []string
	seen := make(map[string]bool)
	lines := strings.Split(string(data), "\n")

	for i, line := range lines {
		// Local IPs appear after "/32 host LOCAL"
		trimmed := strings.TrimSpace(line)
		if strings.Contains(trimmed, "/32 host LOCAL") && i > 0 {
			prevLine := strings.TrimSpace(lines[i-1])
			// Check that it's a valid IP
			parts := strings.Split(prevLine, "|-- ")
			if len(parts) == 2 {
				ip := strings.TrimSpace(parts[1])
				// Ignore localhost and Docker IPs
				if ip != "127.0.0.1" && !strings.HasPrefix(ip, "172.") && !strings.HasPrefix(ip, "192.168.") && !seen[ip] {
					seen[ip] = true
					ips = append(ips, ip)
				}
			}
		}
	}

	// If no IPs found (filtering too aggressive), include the 192.168 and 10.x
	if len(ips) == 0 {
		seen = make(map[string]bool)
		for i, line := range lines {
			trimmed := strings.TrimSpace(line)
			if strings.Contains(trimmed, "/32 host LOCAL") && i > 0 {
				prevLine := strings.TrimSpace(lines[i-1])
				parts := strings.Split(prevLine, "|-- ")
				if len(parts) == 2 {
					ip := strings.TrimSpace(parts[1])
					if ip != "127.0.0.1" && !seen[ip] {
						seen[ip] = true
						ips = append(ips, ip)
					}
				}
			}
		}
	}

	return ips
}

// GetUptime reads /proc/uptime
func GetUptime(procPath string) (uint64, error) {
	if procPath == "" {
		procPath = "/proc"
	}
	data, err := os.ReadFile(filepath.Join(procPath, "uptime"))
	if err != nil {
		return 0, fmt.Errorf("failed to read /proc/uptime: %w", err)
	}

	fields := strings.Fields(string(data))
	if len(fields) < 1 {
		return 0, fmt.Errorf("unexpected /proc/uptime format")
	}

	uptime, err := strconv.ParseFloat(fields[0], 64)
	if err != nil {
		return 0, err
	}

	return uint64(uptime), nil
}

// GetLoadAvg reads /proc/loadavg
func GetLoadAvg(procPath string) (*LoadAvg, error) {
	if procPath == "" {
		procPath = "/proc"
	}
	data, err := os.ReadFile(filepath.Join(procPath, "loadavg"))
	if err != nil {
		return nil, fmt.Errorf("failed to read /proc/loadavg: %w", err)
	}

	fields := strings.Fields(string(data))
	if len(fields) < 3 {
		return nil, fmt.Errorf("unexpected /proc/loadavg format")
	}

	avg1, _ := strconv.ParseFloat(fields[0], 64)
	avg5, _ := strconv.ParseFloat(fields[1], 64)
	avg15, _ := strconv.ParseFloat(fields[2], 64)

	return &LoadAvg{Avg1: avg1, Avg5: avg5, Avg15: avg15}, nil
}

func readOSRelease() map[string]string {
	result := make(map[string]string)

	// Try several paths (mounted host or local)
	paths := []string{
		"/host/etc/os-release",
		"/etc/os-release",
		"/usr/lib/os-release",
	}

	for _, path := range paths {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(data), "\n") {
			parts := strings.SplitN(line, "=", 2)
			if len(parts) == 2 {
				key := parts[0]
				val := strings.Trim(parts[1], "\"")
				result[key] = val
			}
		}
		break
	}

	return result
}
