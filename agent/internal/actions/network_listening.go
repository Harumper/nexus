package actions

import (
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"
)

func init() {
	Register(&ListeningServicesAction{})
}

// ═══════════════════════════════════════════════════════════════
// network.listening_services: lists listening TCP sockets (ss -tlnp)
// to feed the firewall assistant (propose allow for the detected
// services + default-deny). READ-ONLY.
// ═══════════════════════════════════════════════════════════════

type ListeningServicesAction struct{}

func (a *ListeningServicesAction) ID() string                              { return "network.listening_services" }
func (a *ListeningServicesAction) Capability() string                      { return "monitoring" }
func (a *ListeningServicesAction) Validate(_ map[string]interface{}) error { return nil }

var ssPaths = []string{"/usr/sbin/ss", "/usr/bin/ss"}

func ssPath() string {
	for _, p := range ssPaths {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return ""
}

func (a *ListeningServicesAction) Execute(_ map[string]interface{}) (interface{}, error) {
	bin := ssPath()
	if bin == "" {
		return nil, fmt.Errorf("ss (iproute2) not found")
	}
	// -H no header, -t tcp, -l listening, -n numeric, -p process (sudo
	// required to see process names). Fallback without -p if sudo fails.
	out, err := exec.Command("sudo", "-n", bin, "-Htlnp").Output()
	if err != nil {
		out, err = exec.Command(bin, "-Htln").Output()
		if err != nil {
			return nil, fmt.Errorf("ss: %w", err)
		}
	}
	return map[string]interface{}{
		"services": parseSsListening(string(out)),
	}, nil
}

type listeningService struct {
	Proto         string `json:"proto"`
	Address       string `json:"address"`
	Port          string `json:"port"`
	Process       string `json:"process"`
	Exposed       bool   `json:"exposed"` // listens on a non-loopback address
	IsSSH         bool   `json:"is_ssh"`
	DockerManaged bool   `json:"docker_managed"` // published by Docker (own iptables rules → ufw ineffective)
}

var ssProcRegex = regexp.MustCompile(`\(\("([^"]+)"`)

// parseSsListening parses the output of `ss -Htlnp` (one socket per line).
func parseSsListening(out string) []listeningService {
	seen := map[string]bool{}
	services := []listeningService{}
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 4 {
			continue
		}
		// fields: state recv-q send-q local-addr:port peer ...
		local := fields[3]
		idx := strings.LastIndex(local, ":")
		if idx < 0 {
			continue
		}
		addr := local[:idx]
		port := local[idx+1:]
		if port == "" || port == "*" {
			continue
		}

		proc := ""
		if m := ssProcRegex.FindStringSubmatch(line); m != nil {
			proc = m[1]
		}

		key := "tcp/" + port + "/" + addr
		if seen[key] {
			continue
		}
		seen[key] = true

		isSSH := proc == "sshd" || port == "22"
		// docker-proxy = port published by Docker; dockerd = same (host net).
		// These ports are managed by Docker's iptables rules, ufw does not
		// filter them → we mark them to exclude them from the firewall assistant.
		dockerManaged := proc == "docker-proxy" || proc == "dockerd"
		services = append(services, listeningService{
			Proto:         "tcp",
			Address:       addr,
			Port:          port,
			Process:       proc,
			Exposed:       isExposedAddr(addr),
			IsSSH:         isSSH,
			DockerManaged: dockerManaged,
		})
	}
	return services
}

// isExposedAddr: true if the listening address is not loopback
// (thus reachable from outside → relevant for the firewall).
func isExposedAddr(addr string) bool {
	if strings.HasPrefix(addr, "127.") {
		return false
	}
	if addr == "[::1]" || addr == "::1" {
		return false
	}
	if strings.Contains(addr, "%lo") {
		return false
	}
	return true
}
