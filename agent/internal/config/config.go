package config

import (
	"fmt"
	"os"
	"strconv"
)

type Config struct {
	// Server connection
	ServerURL      string
	MachineID      string
	EnrollmentToken string
	ServerPublicKey string

	// Paths
	KeyPath    string
	ProcPath   string
	SysPath    string
	ModulesDir string

	// Intervals (seconds)
	HeartbeatInterval int
	MetricsInterval   int

	// Agent
	AgentType       string
	ProcessInterval int
	Version         string
}

func Load() (*Config, error) {
	cfg := &Config{
		ServerURL:         getEnv("NEXUS_SERVER_URL", "ws://localhost:26031/ws/agent"),
		MachineID:         getEnv("NEXUS_MACHINE_ID", ""),
		EnrollmentToken:   getEnv("NEXUS_ENROLLMENT_TOKEN", ""),
		ServerPublicKey:   loadServerPublicKey(),
		KeyPath:           getEnv("NEXUS_KEY_PATH", "/opt/nexus/keys"),
		ProcPath:          getEnv("NEXUS_PROC_PATH", "/proc"),
		SysPath:           getEnv("NEXUS_SYS_PATH", "/sys"),
		ModulesDir:        getEnv("NEXUS_MODULES_DIR", "/opt/nexus/modules"),
		HeartbeatInterval: getEnvInt("NEXUS_HEARTBEAT_INTERVAL", 30),
		MetricsInterval:   getEnvInt("NEXUS_METRICS_INTERVAL", 60),
		AgentType:         getEnv("NEXUS_AGENT_TYPE", "agent"),
		ProcessInterval:   getEnvInt("NEXUS_PROCESS_INTERVAL", 600),
		Version:           "dev", // écrasé par main.Version (injecté au build)
	}

	if cfg.ServerURL == "" {
		return nil, fmt.Errorf("NEXUS_SERVER_URL is required")
	}

	return cfg, nil
}

// loadServerPublicKey charge la cle publique du serveur depuis :
// 1. NEXUS_SERVER_PUBLIC_KEY (PEM inline, legacy) — deconseille pour systemd
// 2. NEXUS_SERVER_PUBLIC_KEY_FILE (chemin vers un fichier PEM) — recommande
func loadServerPublicKey() string {
	if inline := os.Getenv("NEXUS_SERVER_PUBLIC_KEY"); inline != "" {
		return inline
	}
	if path := os.Getenv("NEXUS_SERVER_PUBLIC_KEY_FILE"); path != "" {
		if data, err := os.ReadFile(path); err == nil {
			return string(data)
		}
	}
	return ""
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func getEnvInt(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if i, err := strconv.Atoi(v); err == nil {
			return i
		}
	}
	return fallback
}
