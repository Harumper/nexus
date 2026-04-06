package collector

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// NetworkInterface represents stats for a single network interface
type NetworkInterface struct {
	Name         string  `json:"name"`
	RxBytes      uint64  `json:"rx_bytes"`
	TxBytes      uint64  `json:"tx_bytes"`
	RxPackets    uint64  `json:"rx_packets"`
	TxPackets    uint64  `json:"tx_packets"`
	RxErrors     uint64  `json:"rx_errors"`
	TxErrors     uint64  `json:"tx_errors"`
	RxBytesPerSec float64 `json:"rx_bytes_per_sec"`
	TxBytesPerSec float64 `json:"tx_bytes_per_sec"`
}

var (
	prevNetStats map[string]*NetworkInterface
	prevNetTime  time.Time
)

// GetNetworkStats lit /proc/net/dev et retourne les stats réseau par interface
func GetNetworkStats(procPath string) ([]NetworkInterface, error) {
	devPath := filepath.Join(procPath, "net", "dev")

	data, err := os.ReadFile(devPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read %s: %w", devPath, err)
	}

	lines := strings.Split(string(data), "\n")
	now := time.Now()

	var interfaces []NetworkInterface

	// Skip the first 2 header lines
	for i := 2; i < len(lines); i++ {
		line := strings.TrimSpace(lines[i])
		if line == "" {
			continue
		}

		// Format: iface: rx_bytes rx_packets rx_errs rx_drop rx_fifo rx_frame rx_compressed rx_multicast tx_bytes tx_packets tx_errs tx_drop tx_fifo tx_colls tx_carrier tx_compressed
		colonIdx := strings.Index(line, ":")
		if colonIdx < 0 {
			continue
		}

		name := strings.TrimSpace(line[:colonIdx])

		// Skip loopback
		if name == "lo" {
			continue
		}

		fields := strings.Fields(line[colonIdx+1:])
		if len(fields) < 16 {
			continue
		}

		rxBytes, _ := strconv.ParseUint(fields[0], 10, 64)
		rxPackets, _ := strconv.ParseUint(fields[1], 10, 64)
		rxErrors, _ := strconv.ParseUint(fields[2], 10, 64)
		txBytes, _ := strconv.ParseUint(fields[8], 10, 64)
		txPackets, _ := strconv.ParseUint(fields[9], 10, 64)
		txErrors, _ := strconv.ParseUint(fields[10], 10, 64)

		iface := NetworkInterface{
			Name:      name,
			RxBytes:   rxBytes,
			TxBytes:   txBytes,
			RxPackets: rxPackets,
			TxPackets: txPackets,
			RxErrors:  rxErrors,
			TxErrors:  txErrors,
		}

		// Calculate bytes/sec if we have previous readings
		if prevNetStats != nil {
			elapsed := now.Sub(prevNetTime).Seconds()
			if elapsed > 0 {
				if prev, ok := prevNetStats[name]; ok {
					iface.RxBytesPerSec = float64(rxBytes-prev.RxBytes) / elapsed
					iface.TxBytesPerSec = float64(txBytes-prev.TxBytes) / elapsed
				}
			}
		}

		interfaces = append(interfaces, iface)
	}

	// Update previous stats for next call
	prevNetStats = make(map[string]*NetworkInterface)
	for i := range interfaces {
		iface := interfaces[i]
		prevNetStats[iface.Name] = &iface
	}
	prevNetTime = now

	return interfaces, nil
}
