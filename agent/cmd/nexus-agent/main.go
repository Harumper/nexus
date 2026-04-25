package main

import (
	"encoding/json"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/nexus/agent/internal/actions"
	"github.com/nexus/agent/internal/collector"
	"github.com/nexus/agent/internal/config"
	"github.com/nexus/agent/internal/security"
	"github.com/nexus/agent/internal/transport"
)

var (
	Version   = "0.1.0"
	agentType string

	// probeAllowedActions is the whitelist of actions allowed in probe mode.
	// Doit correspondre a PROBE_ALLOWED_ACTIONS cote backend (machine-manager.ts).
	probeAllowedActions = map[string]bool{
		"system.metrics":            true,
		"system.info":               true,
		"system.processes":          true,
		"system.heartbeat":          true,
		"system.logs":               true,
		"system.services_list":      true,
		"system.service_status":     true,
		"system.package_list":       true,
		"firewall.status":           true,
		"storage.lvm_list":          true,
		"storage.block_devices":     true,
		"storage.filesystem_usage":  true,
		"cron.list":                 true,
		"timer.list":                true,
		"user.list":                 true,
		"sshkey.list":               true,
		"network.status":            true,
		"network.interfaces":        true,
		"netplan.get":               true,
		"package.holds_list":        true,
		"system.services_failed":    true,
		"system.timers_failed":      true,
		"system.updates_available":  true,
		"system.health_summary":     true,
		"ssl.scan":                  true,
		"agent.sudoers_check":       true,
	}
)

func main() {
	log.SetFlags(log.LstdFlags | log.Lshortfile)

	// Charger la configuration
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}
	cfg.Version = Version
	agentType = cfg.AgentType

	logPrefix := "[Nexus Agent]"
	if agentType == "probe" {
		logPrefix = "[Nexus Probe]"
	}
	log.Printf("%s Version %s starting...", logPrefix, Version)

	// Dead man's switch : si l'agent a crash pendant une modif (firewall/netplan),
	// revert tous les snapshots pending au demarrage
	actions.RecoverPendingSnapshots()
	actions.RecoverPendingNetplan()

	// Initialiser le keystore
	keystore := security.NewKeystore(cfg.KeyPath)
	sandbox := security.NewSandbox()

	// Créer le client WebSocket
	client := transport.NewClient(cfg.ServerURL, cfg.MachineID)

	// Se connecter au serveur
	log.Printf("[Agent] Connecting to %s...", cfg.ServerURL)
	if err := client.Connect(); err != nil {
		log.Fatalf("Failed to connect: %v", err)
	}

	// Enrollment si nécessaire
	if !keystore.HasSharedSecret() {
		if cfg.EnrollmentToken == "" {
			log.Fatal("No shared secret found and no enrollment token provided. Cannot authenticate.")
		}

		// Démarrer la lecture en background pour recevoir la réponse d'enrollment
		go client.ReadLoop()

		result, err := security.Enroll(
			client.SendRaw,
			client.ReceiveRaw,
			cfg.MachineID,
			cfg.EnrollmentToken,
			cfg.ServerPublicKey,
			keystore,
		)
		if err != nil {
			log.Fatalf("Enrollment failed: %v", err)
		}

		if result.MachineType != "" {
			agentType = result.MachineType
		}
		client.SetKeys(keystore.GetPrivateKey(), result.SharedSecret)

		// Après enrollment, se reconnecter pour un flux propre
		log.Println("[Agent] Reconnecting after enrollment...")
		client.Close()
		time.Sleep(1 * time.Second)
		client = transport.NewClient(cfg.ServerURL, cfg.MachineID)
		client.SetKeys(keystore.GetPrivateKey(), result.SharedSecret)
		if err := client.Connect(); err != nil {
			log.Fatalf("Failed to reconnect: %v", err)
		}
	} else {
		// Charger les clés existantes
		if err := keystore.Load(); err != nil {
			log.Fatalf("Failed to load keys: %v", err)
		}
		sharedSecret, err := keystore.LoadSharedSecret()
		if err != nil {
			log.Fatalf("Failed to load shared secret: %v", err)
		}
		client.SetKeys(keystore.GetPrivateKey(), sharedSecret)
	}

	log.Printf("[Agent] Authenticated (type=%s)", agentType)
	log.Printf("[Agent] Registered actions: %v", actions.ListAll())

	// Connecter le callback de progression des mises à jour
	actions.OnUpdateProgress = func(line string, percent int) {
		client.SendSigned(transport.TypeUpdateProgress, "", map[string]interface{}{
			"line":    line,
			"percent": percent,
		})
	}

	// Handler pour les messages entrants
	client.OnMessage(func(msg transport.Message) {
		handleMessage(msg, client, sandbox, cfg, keystore)
	})

	// Démarrer la boucle de lecture (une seule fois)
	go client.ReadLoop()

	// Démarrer le heartbeat
	go runHeartbeat(client, cfg)

	// Démarrer la collecte de métriques
	go runMetrics(client, cfg)

	log.Println("[Agent] Running. Waiting for signals...")

	// Attendre le signal d'arrêt
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh

	log.Println("[Agent] Shutting down...")
	client.Close()
}

func handleMessage(msg transport.Message, client *transport.Client, sandbox *security.Sandbox, cfg *config.Config, keystore *security.Keystore) {
	switch msg.Type {
	case transport.TypeActionRequest:
		// Valider le timestamp pour eviter les replay attacks
		if msg.Timestamp != "" && !security.IsTimestampValid(msg.Timestamp, 60*time.Second) {
			log.Printf("[Agent] Rejected action request: timestamp too old or invalid (%s)", msg.Timestamp)
			return
		}
		go handleActionRequest(msg, client, sandbox, keystore)

	case transport.TypeActionConfirm:
		// Confirmation d'une action firewall/netplan (watchdog-revert)
		// On dispatch selon le prefix du request_id
		if strings.HasPrefix(msg.RequestID, "netplan-") {
			actions.HandleNetplanConfirm(msg.RequestID)
		} else {
			actions.HandleConfirm(msg.RequestID)
		}

	case transport.TypePing:
		client.SendSigned(transport.TypePong, "", map[string]interface{}{})

	case transport.TypeError:
		errMsg := msg.Error
		if errMsg == "" {
			errMsg = msg.Payload
		}
		log.Printf("[Agent] Server error: %s", errMsg)
	}
}

func handleActionRequest(msg transport.Message, client *transport.Client, sandbox *security.Sandbox, keystore *security.Keystore) {
	sharedSecret, err := keystore.LoadSharedSecret()
	if err != nil {
		log.Printf("[Agent] Failed to load shared secret: %v", err)
		return
	}

	decrypted, err := security.DecryptAES(msg.Payload, sharedSecret)
	if err != nil {
		log.Printf("[Agent] Failed to decrypt action request: %v", err)
		return
	}

	var request transport.ActionRequestPayload
	if err := json.Unmarshal([]byte(decrypted), &request); err != nil {
		log.Printf("[Agent] Failed to parse action request: %v", err)
		return
	}

	log.Printf("[Agent] Action request: %s (request_id: %s)", request.ActionID, request.RequestID)

	// In probe mode, only allow whitelisted actions
	if strings.EqualFold(agentType, "probe") {
		if !probeAllowedActions[request.ActionID] {
			sendActionResponse(client, request.RequestID, request.ActionID, false, nil, "action not allowed in probe mode")
			return
		}
	}

	action, ok := actions.Get(request.ActionID)
	if !ok {
		sendActionResponse(client, request.RequestID, request.ActionID, false, nil, "unknown action")
		return
	}

	result, err := sandbox.ValidateAndExecute(action, request.Params)
	if err != nil {
		sendActionResponse(client, request.RequestID, request.ActionID, false, nil, err.Error())
		return
	}

	sendActionResponse(client, request.RequestID, request.ActionID, true, result, "")
}

func sendActionResponse(client *transport.Client, requestID, actionID string, success bool, data interface{}, errMsg string) {
	response := map[string]interface{}{
		"request_id": requestID,
		"action_id":  actionID,
		"success":    success,
	}
	if data != nil {
		response["data"] = data
	}
	if errMsg != "" {
		response["error"] = errMsg
	}

	if err := client.SendSigned(transport.TypeActionResponse, requestID, response); err != nil {
		log.Printf("[Agent] Failed to send action response: %v", err)
	}
}

func runHeartbeat(client *transport.Client, cfg *config.Config) {
	ticker := time.NewTicker(time.Duration(cfg.HeartbeatInterval) * time.Second)
	defer ticker.Stop()

	// Envoyer immédiatement
	sendHeartbeat(client, cfg)

	for range ticker.C {
		sendHeartbeat(client, cfg)
	}
}

func sendHeartbeat(client *transport.Client, cfg *config.Config) {
	// Check if reboot is required
	rebootRequired := false
	rebootPaths := []string{"/var/run/reboot-required"}
	if cfg.ProcPath != "/proc" && cfg.ProcPath != "" {
		// Also check with procPath prefix (e.g. /host/proc -> /host/var/run/reboot-required)
		hostPrefix := filepath.Dir(cfg.ProcPath)
		rebootPaths = append(rebootPaths, filepath.Join(hostPrefix, "var/run/reboot-required"))
	}
	for _, p := range rebootPaths {
		if _, err := os.Stat(p); err == nil {
			rebootRequired = true
			break
		}
	}

	data := map[string]interface{}{
		"uptime":          0,
		"agent_version":   cfg.Version,
		"agent_type":      cfg.AgentType,
		"reboot_required": rebootRequired,
		"sudoers_hash":    actions.GetSudoersHash(),
	}
	if err := client.SendSigned(transport.TypeHeartbeat, "", data); err != nil {
		log.Printf("[Agent] Failed to send heartbeat: %v", err)
	}
}

func runMetrics(client *transport.Client, cfg *config.Config) {
	// Attendre un peu avant la première collecte
	time.Sleep(5 * time.Second)

	ticker := time.NewTicker(time.Duration(cfg.MetricsInterval) * time.Second)
	defer ticker.Stop()

	var metricsCycle int
	processCycleInterval := cfg.ProcessInterval / cfg.MetricsInterval
	if processCycleInterval < 1 {
		processCycleInterval = 1
	}

	sendMetrics(client, cfg, metricsCycle, processCycleInterval)
	metricsCycle++

	for range ticker.C {
		sendMetrics(client, cfg, metricsCycle, processCycleInterval)
		metricsCycle++
	}
}

func sendMetrics(client *transport.Client, cfg *config.Config, cycle int, processCycleInterval int) {
	metricsAction, ok := actions.Get("system.metrics")
	if !ok {
		return
	}

	result, err := metricsAction.Execute(nil)
	if err != nil {
		log.Printf("[Agent] Failed to collect metrics: %v", err)
		return
	}

	// Enrich metrics with network stats
	if metricsMap, ok := result.(map[string]interface{}); ok {
		networkStats, err := collector.GetNetworkStats(cfg.ProcPath)
		if err == nil {
			metricsMap["network"] = networkStats
		}

		// Collect top processes periodically
		if cycle%processCycleInterval == 0 {
			processes, err := collector.GetTopProcesses(cfg.ProcPath, 10)
			if err == nil {
				metricsMap["processes"] = processes
			}
		}

		result = metricsMap
	}

	if err := client.SendSigned(transport.TypeMetricsReport, "", result); err != nil {
		log.Printf("[Agent] Failed to send metrics: %v", err)
	}
}
