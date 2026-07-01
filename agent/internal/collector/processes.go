package collector

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"
)

// ProcessInfo represents a single process's resource usage
type ProcessInfo struct {
	PID        int     `json:"pid"`
	Name       string  `json:"name"`
	CPUPercent float64 `json:"cpu_percent"`
	MemPercent float64 `json:"mem_percent"`
	MemRSS     uint64  `json:"mem_rss"`
	User       string  `json:"user"`
	Command    string  `json:"command"`
}

// ProcessList holds the top processes by CPU and memory
type ProcessList struct {
	TopCPU    []ProcessInfo `json:"top_cpu"`
	TopMemory []ProcessInfo `json:"top_memory"`
}

type procStat struct {
	pid   int
	name  string
	utime uint64
	stime uint64
}

// GetTopProcesses returns the top processes by CPU and memory
func GetTopProcesses(procPath string, count int) (*ProcessList, error) {
	numCPUs := runtime.NumCPU()

	// First pass: read all process stats
	firstPass, err := readAllProcStats(procPath)
	if err != nil {
		return nil, err
	}

	// Sleep 1 second for CPU delta measurement
	time.Sleep(1 * time.Second)

	// Second pass
	secondPass, err := readAllProcStats(procPath)
	if err != nil {
		return nil, err
	}

	// Get total memory for mem% calculation
	memInfo, err := GetMemory(procPath)
	if err != nil {
		return nil, fmt.Errorf("failed to get memory info: %w", err)
	}

	// Build process info list
	var processes []ProcessInfo
	for pid, stat2 := range secondPass {
		stat1, ok := firstPass[pid]
		if !ok {
			continue
		}

		// CPU% = (delta_utime + delta_stime) / (elapsed_seconds * num_cpus) * 100
		deltaUtime := stat2.utime - stat1.utime
		deltaStime := stat2.stime - stat1.stime
		// /proc/stat times are in clock ticks (typically 100 Hz)
		cpuPercent := float64(deltaUtime+deltaStime) / (1.0 * float64(numCPUs) * 100.0) * 100.0

		// Read memory and user info from /proc/[pid]/status
		memRSS, uid := readProcStatus(procPath, pid)

		var memPercent float64
		if memInfo.Total > 0 {
			memPercent = float64(memRSS) / float64(memInfo.Total) * 100.0
		}

		// Read command line
		command := readProcCmdline(procPath, pid)
		if command == "" {
			command = stat2.name
		}

		processes = append(processes, ProcessInfo{
			PID:        pid,
			Name:       stat2.name,
			CPUPercent: cpuPercent,
			MemPercent: memPercent,
			MemRSS:     memRSS,
			User:       uid,
			Command:    command,
		})
	}

	// Sort by CPU% desc and take top count
	sort.Slice(processes, func(i, j int) bool {
		return processes[i].CPUPercent > processes[j].CPUPercent
	})
	topCPU := make([]ProcessInfo, 0, count)
	for i := 0; i < len(processes) && i < count; i++ {
		topCPU = append(topCPU, processes[i])
	}

	// Sort by MEM% desc and take top count
	sort.Slice(processes, func(i, j int) bool {
		return processes[i].MemPercent > processes[j].MemPercent
	})
	topMem := make([]ProcessInfo, 0, count)
	for i := 0; i < len(processes) && i < count; i++ {
		topMem = append(topMem, processes[i])
	}

	return &ProcessList{
		TopCPU:    topCPU,
		TopMemory: topMem,
	}, nil
}

// readAllProcStats reads /proc/[pid]/stat for all numeric PID directories
func readAllProcStats(procPath string) (map[int]*procStat, error) {
	entries, err := os.ReadDir(procPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read %s: %w", procPath, err)
	}

	stats := make(map[int]*procStat)
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		pid, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue // not a PID directory
		}

		statPath := filepath.Join(procPath, entry.Name(), "stat")
		data, err := os.ReadFile(statPath)
		if err != nil {
			continue // process may have exited
		}

		s, err := parseProcStat(pid, string(data))
		if err != nil {
			continue
		}
		stats[pid] = s
	}

	return stats, nil
}

// parseProcStat parses a line from /proc/[pid]/stat
// Format: pid (comm) state ppid pgrp session tty_nr tpgid flags
//
//	minflt cminflt majflt cmajflt utime stime ...
//
// Fields are space-separated, but comm can contain spaces and is in parens
func parseProcStat(pid int, data string) (*procStat, error) {
	// Find the comm field (between first '(' and last ')')
	openParen := strings.IndexByte(data, '(')
	closeParen := strings.LastIndexByte(data, ')')
	if openParen < 0 || closeParen < 0 || closeParen <= openParen {
		return nil, fmt.Errorf("invalid stat format for pid %d", pid)
	}

	name := data[openParen+1 : closeParen]

	// Fields after the closing paren
	rest := strings.Fields(data[closeParen+2:])
	// rest[0] = state, rest[1] = ppid, ..., rest[11] = utime, rest[12] = stime
	if len(rest) < 13 {
		return nil, fmt.Errorf("not enough fields in stat for pid %d", pid)
	}

	utime, err := strconv.ParseUint(rest[11], 10, 64)
	if err != nil {
		return nil, fmt.Errorf("failed to parse utime for pid %d: %w", pid, err)
	}
	stime, err := strconv.ParseUint(rest[12], 10, 64)
	if err != nil {
		return nil, fmt.Errorf("failed to parse stime for pid %d: %w", pid, err)
	}

	return &procStat{
		pid:   pid,
		name:  name,
		utime: utime,
		stime: stime,
	}, nil
}

// readProcStatus reads VmRSS and Uid from /proc/[pid]/status
func readProcStatus(procPath string, pid int) (memRSS uint64, uid string) {
	statusPath := filepath.Join(procPath, strconv.Itoa(pid), "status")
	data, err := os.ReadFile(statusPath)
	if err != nil {
		return 0, ""
	}

	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "VmRSS:") {
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				val, err := strconv.ParseUint(fields[1], 10, 64)
				if err == nil {
					memRSS = val * 1024 // kB to bytes
				}
			}
		} else if strings.HasPrefix(line, "Uid:") {
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				uid = fields[1] // effective UID as string
			}
		}
	}
	return
}

// readProcCmdline reads /proc/[pid]/cmdline
func readProcCmdline(procPath string, pid int) string {
	cmdlinePath := filepath.Join(procPath, strconv.Itoa(pid), "cmdline")
	data, err := os.ReadFile(cmdlinePath)
	if err != nil || len(data) == 0 {
		return ""
	}
	// cmdline is null-separated
	cmd := strings.ReplaceAll(string(data), "\x00", " ")
	return strings.TrimSpace(cmd)
}
