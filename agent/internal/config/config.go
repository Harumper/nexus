package config

import (
	"fmt"
	"log"
	"os"
	"strconv"
	"strings"
)

type Config struct {
	// Server connection
	ServerURL       string
	MachineID       string
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
	ProcessInterval int
	Version         string
}

func Load() (*Config, error) {
	cfg := &Config{
		ServerURL:         getEnv("NEXUS_SERVER_URL", "wss://localhost:26031/ws/agent"),
		MachineID:         getEnv("NEXUS_MACHINE_ID", ""),
		EnrollmentToken:   getEnv("NEXUS_ENROLLMENT_TOKEN", ""),
		ServerPublicKey:   loadServerPublicKey(),
		KeyPath:           getEnv("NEXUS_KEY_PATH", "/opt/nexus/keys"),
		ProcPath:          getEnv("NEXUS_PROC_PATH", "/proc"),
		SysPath:           getEnv("NEXUS_SYS_PATH", "/sys"),
		ModulesDir:        getEnv("NEXUS_MODULES_DIR", "/opt/nexus/modules"),
		HeartbeatInterval: getEnvInt("NEXUS_HEARTBEAT_INTERVAL", 30),
		MetricsInterval:   getEnvInt("NEXUS_METRICS_INTERVAL", 60),
		ProcessInterval:   getEnvInt("NEXUS_PROCESS_INTERVAL", 600),
		Version:           "dev", // overwritten by main.Version (injected at build)
	}

	if cfg.ServerURL == "" {
		return nil, fmt.Errorf("NEXUS_SERVER_URL is required")
	}

	// NEXUS-ENROLLMENT-001 — layer 1: force wss:// (TLS mandatory for the
	// bootstrap). The enrollment request carries the single-use token AND the
	// agent's public key in clear at the application level; without TLS, an
	// on-path attacker reads the token and substitutes its own key. Pinning the
	// server key only protects the RESPONSE, not this request. Fail-closed: any
	// scheme ≠ wss:// is refused at boot, except with the EXPLICIT override
	// NEXUS_ALLOW_INSECURE=1 (local dev on a trusted network only).
	allowInsecure := getEnv("NEXUS_ALLOW_INSECURE", "") == "1"
	if !strings.HasPrefix(cfg.ServerURL, "wss://") {
		if !allowInsecure {
			return nil, fmt.Errorf("NEXUS_SERVER_URL must use wss:// (TLS mandatory for the bootstrap); scheme provided: %q. "+
				"Set NEXUS_ALLOW_INSECURE=1 for local dev only", cfg.ServerURL)
		}
		// Override active AND cleartext transport: warn LOUDLY on EVERY boot,
		// never a silent escape hatch.
		log.Printf("[Agent] ⚠️  SECURITY: NEXUS_ALLOW_INSECURE=1 — UNENCRYPTED transport (%s). "+
			"The enrollment token and the agent's public key travel IN CLEAR (MITM possible at bootstrap). "+
			"Reserve this for local dev on a trusted network; use wss:// in production.", cfg.ServerURL)
	}

	return cfg, nil
}

// loadServerPublicKey loads the server's public key from:
// 1. NEXUS_SERVER_PUBLIC_KEY (inline PEM, legacy) — discouraged for systemd
// 2. NEXUS_SERVER_PUBLIC_KEY_FILE (path to a PEM file) — recommended
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
