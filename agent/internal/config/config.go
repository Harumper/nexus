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
		Version:           "dev", // écrasé par main.Version (injecté au build)
	}

	if cfg.ServerURL == "" {
		return nil, fmt.Errorf("NEXUS_SERVER_URL is required")
	}

	// NEXUS-ENROLLMENT-001 — couche 1 : forcer wss:// (TLS obligatoire pour le
	// bootstrap). La requête d'enrôlement porte le token single-use ET la clé
	// publique de l'agent en clair au niveau applicatif ; sans TLS, un attaquant
	// on-path lit le token et substitue sa propre clé. Le pinning de la clé serveur
	// ne protège que la RÉPONSE, pas cette requête. Fail-closed : tout schéma ≠
	// wss:// est refusé au boot, sauf override EXPLICITE NEXUS_ALLOW_INSECURE=1
	// (dev local sur réseau de confiance uniquement).
	allowInsecure := getEnv("NEXUS_ALLOW_INSECURE", "") == "1"
	if !strings.HasPrefix(cfg.ServerURL, "wss://") {
		if !allowInsecure {
			return nil, fmt.Errorf("NEXUS_SERVER_URL doit utiliser wss:// (TLS obligatoire pour le bootstrap) ; schéma fourni: %q. "+
				"Posez NEXUS_ALLOW_INSECURE=1 pour le dev local uniquement", cfg.ServerURL)
		}
		// Override actif ET transport en clair : avertir BRUYAMMENT à CHAQUE boot,
		// jamais une échappatoire silencieuse.
		log.Printf("[Agent] ⚠️  SÉCURITÉ: NEXUS_ALLOW_INSECURE=1 — transport NON CHIFFRÉ (%s). "+
			"Le token d'enrôlement et la clé publique de l'agent transitent EN CLAIR (MITM possible au bootstrap). "+
			"À réserver au dev local sur réseau de confiance ; utilisez wss:// en production.", cfg.ServerURL)
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
