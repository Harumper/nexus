package main

import (
	"crypto/ecdsa"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/nexus/agent/internal/actions"
	"github.com/nexus/agent/internal/collector"
	"github.com/nexus/agent/internal/config"
	"github.com/nexus/agent/internal/privhelper"
	"github.com/nexus/agent/internal/security"
	"github.com/nexus/agent/internal/transport"
)

// selfSHA256 renvoie le SHA256 (hex) du binaire de l'agent en cours
// d'exécution, calculé une seule fois. Sert au backend pour comparer la
// version installée à celle qu'il sert (détection "à jour" + fin d'upgrade).
var (
	selfSHAOnce  sync.Once
	selfSHAValue string
)

// ===================== Idempotence des actions =====================
// Un même request_id ne doit JAMAIS être ré-exécuté : un re-dispatch (ou une
// redélivraison WS de la même trame après perte d'ack) rejouerait une mutation
// destructrice (reboot, apt remove, user.create...). On mémorise les request_id
// traités + leur réponse pour renvoyer le résultat sans ré-exécuter.
type idemEntry struct {
	done     bool
	response map[string]interface{}
	at       time.Time
}

var (
	idemMu    sync.Mutex
	idemCache = make(map[string]*idemEntry)
)

const idemTTL = 10 * time.Minute

// idemReserve réserve un request_id pour exécution. Retourne (réponse mémorisée,
// estDuplicata). Si duplicata et exécution terminée, la réponse est non-nil.
func idemReserve(requestID string) (map[string]interface{}, bool) {
	idemMu.Lock()
	defer idemMu.Unlock()
	for k, e := range idemCache {
		if time.Since(e.at) > idemTTL {
			delete(idemCache, k)
		}
	}
	if e, ok := idemCache[requestID]; ok {
		if e.done {
			return e.response, true
		}
		return nil, true
	}
	idemCache[requestID] = &idemEntry{at: time.Now()}
	return nil, false
}

// idemComplete enregistre la réponse finale pour un request_id réservé.
func idemComplete(requestID string, response map[string]interface{}) {
	idemMu.Lock()
	defer idemMu.Unlock()
	if e, ok := idemCache[requestID]; ok {
		e.done = true
		e.response = response
		e.at = time.Now()
	}
}

func selfSHA256() string {
	selfSHAOnce.Do(func() {
		exePath, err := os.Executable()
		if err != nil {
			return
		}
		f, err := os.Open(exePath)
		if err != nil {
			return
		}
		defer f.Close()
		h := sha256.New()
		if _, err := io.Copy(h, f); err != nil {
			return
		}
		selfSHAValue = hex.EncodeToString(h.Sum(nil))
	})
	return selfSHAValue
}

// notifySocket : chemin du socket systemd capturé une seule fois au boot.
// On RETIRE NOTIFY_SOCKET de l'environnement (initSystemdNotify) pour qu'il ne
// soit PAS hérité par les processus enfants (lynis, apt, systemctl…) : sinon
// ces enfants écrivent dans le socket et systemd inonde le journal de
// « Got notification message from PID X, but reception only permitted for main PID ».
// (Équivalent du flag unset_environment de sd_notify.)
var notifySocket string

func initSystemdNotify() {
	notifySocket = os.Getenv("NOTIFY_SOCKET")
	if notifySocket != "" {
		os.Unsetenv("NOTIFY_SOCKET")
	}
}

// sdNotify envoie un message au gestionnaire de service (systemd) via le socket
// capturé au boot. No-op hors systemd. Gère les sockets abstraits (@ -> NUL).
func sdNotify(state string) {
	if notifySocket == "" {
		return
	}
	addr := &net.UnixAddr{Name: notifySocket, Net: "unixgram"}
	if strings.HasPrefix(notifySocket, "@") {
		addr.Name = "\x00" + notifySocket[1:]
	}
	conn, err := net.DialUnix("unixgram", nil, addr)
	if err != nil {
		return
	}
	defer conn.Close()
	conn.Write([]byte(state))
}

// runWatchdog notifie systemd (WATCHDOG=1) à la moitié de l'intervalle
// WatchdogSec. SANS ça, l'unit `WatchdogSec=120` faisait tuer+relancer l'agent
// toutes les 120s (d'où les déconnexions périodiques observées). No-op si le
// watchdog n'est pas activé (WATCHDOG_USEC absent).
func runWatchdog() {
	usecStr := os.Getenv("WATCHDOG_USEC")
	if usecStr == "" {
		return
	}
	usec, err := strconv.Atoi(usecStr)
	if err != nil || usec <= 0 {
		return
	}
	interval := time.Duration(usec) * time.Microsecond / 2
	sdNotify("WATCHDOG=1")
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for range ticker.C {
		sdNotify("WATCHDOG=1")
	}
}

var (
	// Version est injectée au build via -ldflags "-X main.Version=...".
	// "dev" = binaire compilé sans estampillage (build local).
	Version   = "dev"
	agentType string

	// serverPublicKey est la cle publique ECDSA du backend, parsee une fois
	// au boot et utilisee pour verifier les messages serveur (action.confirm).
	serverPublicKey *ecdsa.PublicKey

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
		"network.listening_services": true,
		"netplan.get":               true,
		"package.holds_list":        true,
		"system.services_failed":    true,
		"system.timers_failed":      true,
		"system.updates_available":  true,
		"system.health_summary":     true,
		"ssl.scan":                  true,
		"security.audit":            true,
		"agent.sudoers_check":       true,
		"fs.list":                   true,
		"fs.read":                   true,
		// fs.upload volontairement absent : interdit en mode probe
	}
)

func main() {
	// NEXUS-AGENT-003/008 — mode privhelper (wrapper root COMPILÉ) : invoqué via
	// `sudo nexus-agent privhelper <op> …`, il exécute une opération privilégiée
	// strictement validée puis sort. AVANT tout le reste (pas de config, pas de
	// systemd notify) : c'est un sous-processus root court-vécu, pas l'agent.
	if len(os.Args) >= 2 && os.Args[1] == "privhelper" {
		os.Exit(privhelper.Run(os.Args[2:]))
	}

	// `--version` : utilisé par l'auto-upgrade pour lier la version à l'artefact
	// (SELF-UPGRADE-002). Imprime la version injectée au build et sort.
	if len(os.Args) >= 2 && os.Args[1] == "--version" {
		fmt.Println(Version)
		os.Exit(0)
	}
	actions.RunningVersion = Version

	log.SetFlags(log.LstdFlags | log.Lshortfile)

	// Capturer NOTIFY_SOCKET et le retirer de l'env AVANT de lancer le moindre
	// sous-processus, pour ne pas le fuiter aux enfants (sinon flood du journal).
	initSystemdNotify()

	// Charger la configuration
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}
	cfg.Version = Version
	agentType = cfg.AgentType
	// Origine pinnée pour l'auto-upgrade (SELF-UPGRADE-003).
	actions.PinnedServerURL = cfg.ServerURL

	logPrefix := "[Nexus Agent]"
	if agentType == "probe" {
		logPrefix = "[Nexus Probe]"
	}
	log.Printf("%s Version %s starting...", logPrefix, Version)

	// Parser la cle publique du serveur une fois au boot. Utilisee pour
	// verifier les messages action.confirm (annulation watchdog firewall/netplan).
	// PINNING STRICT (isolation entre projets) : la clé publique du serveur est
	// OBLIGATOIRE. Sans elle, n'importe quel backend pourrait piloter cet agent
	// (et action.request/action.confirm seraient de toute façon rejetés). On
	// échoue donc au boot plutôt que de tourner dans un état inutilisable.
	if cfg.ServerPublicKey == "" {
		log.Fatal("[Agent] FATAL: aucune clé publique serveur configurée (NEXUS_SERVER_PUBLIC_KEY_FILE). " +
			"Elle est obligatoire pour authentifier le backend et isoler l'agent. " +
			"Ré-enrôlez l'agent avec --server-public-key-file (UI : bouton Ré-enrôler).")
	}
	parsedServerKey, err := security.ParsePublicKeyPEM(cfg.ServerPublicKey)
	if err != nil {
		log.Fatalf("Failed to parse server public key: %v", err)
	}
	serverPublicKey = parsedServerKey

	// Dead man's switch : si l'agent a crash pendant une modif (firewall/netplan),
	// revert tous les snapshots pending au demarrage
	actions.RecoverPendingSnapshots()
	actions.RecoverPendingNetplan()
	actions.RecoverPendingSshd()

	// Cleanup périodique de l'inbox fs.upload (fichiers > 7j). Une fois au boot
	// puis toutes les 24h. Pas critique si rate (les fichiers seront pris au
	// prochain tick), donc goroutine non bloquante.
	go func() {
		for {
			if n, err := actions.CleanupInbox(); err != nil {
				log.Printf("[Agent] inbox cleanup error: %v", err)
			} else if n > 0 {
				log.Printf("[Agent] inbox cleanup: %d expired files removed", n)
			}
			time.Sleep(24 * time.Hour)
		}
	}()

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

	// Enrollment si nécessaire (identité = agent.key + marqueur d'enrôlement ;
	// la clé de session AES n'est plus persistée — cf. handshake ci-dessous).
	if !keystore.IsEnrolled() {
		if cfg.EnrollmentToken == "" {
			log.Fatal("Not enrolled and no enrollment token provided. Cannot authenticate.")
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

		// Après enrollment, se reconnecter pour un flux propre (nouveau WS).
		log.Println("[Agent] Reconnecting after enrollment...")
		client.Close()
		time.Sleep(1 * time.Second)
		client = transport.NewClient(cfg.ServerURL, cfg.MachineID)
		if err := client.Connect(); err != nil {
			log.Fatalf("Failed to reconnect: %v", err)
		}
	} else {
		// Charger l'identité long-terme existante
		if err := keystore.Load(); err != nil {
			log.Fatalf("Failed to load keys: %v", err)
		}
	}

	// Handshake ECDHE X25519 (forward secrecy) : dérive la clé de session K en
	// MÉMOIRE sur la connexion établie. Remplace l'ancien shared secret persisté.
	// Au démarrage, sharedSecret=nil → session.hello est signé mais NON chiffré.
	// L'agent sort/redémarre sur perte de connexion (systemd relance) → un nouveau
	// K éphémère est négocié à chaque connexion.
	client.SetKeys(keystore.GetPrivateKey(), nil)
	go client.ReadLoop()
	sessionKey, err := security.PerformSessionHandshake(
		client.SendRaw, client.ReceiveRaw,
		keystore.GetPrivateKey(), serverPublicKey, cfg.MachineID,
	)
	if err != nil {
		log.Fatalf("Session handshake failed: %v", err)
	}
	client.SetKeys(keystore.GetPrivateKey(), sessionKey)

	log.Printf("[Agent] Authenticated (type=%s)", agentType)
	// Propager le mode PROBE au package actions (effets de bord lecture-seule,
	// ex. security.audit qui ne doit pas installer lynis en PROBE).
	actions.SetProbeMode(strings.EqualFold(agentType, "probe"))
	log.Printf("[Agent] Registered actions: %v", actions.ListAll())

	// Connecter le callback de progression des mises à jour système (apt)
	actions.OnUpdateProgress = func(line string, percent int) {
		client.SendSigned(transport.TypeUpdateProgress, "", map[string]interface{}{
			"line":    line,
			"percent": percent,
		})
	}

	// Connecter le callback de progression de la MAJ de l'agent lui-même.
	// Canal distinct : le frontend suit ça dans une modal dédiée jusqu'au
	// redémarrage, puis détecte la reconnexion via le SHA du heartbeat.
	actions.OnAgentUpgradeProgress = func(line string, percent int) {
		client.SendSigned(transport.TypeAgentUpgradeProgress, "", map[string]interface{}{
			"line":    line,
			"percent": percent,
		})
	}

	// Progression de l'audit de sécurité (Lynis) — console live côté UI.
	actions.OnSecurityProgress = func(line string, percent int) {
		client.SendSigned(transport.TypeSecurityProgress, "", map[string]interface{}{
			"line":    line,
			"percent": percent,
		})
	}

	// Handler pour les messages entrants. La boucle de lecture (ReadLoop) a déjà
	// été démarrée avant le handshake ; on branche seulement le dispatcher métier.
	client.OnMessage(func(msg transport.Message) {
		handleMessage(msg, client, sandbox, cfg, keystore)
	})

	// Démarrer le heartbeat
	go runHeartbeat(client, cfg)

	// Démarrer la collecte de métriques
	go runMetrics(client, cfg)

	// Notifier systemd que le service est prêt + entretenir le watchdog
	// (WatchdogSec dans l'unit). Sans ça, systemd tue l'agent périodiquement.
	sdNotify("READY=1")
	go runWatchdog()

	log.Println("[Agent] Running. Waiting for signals...")

	// Attendre soit un signal d'arrêt, soit la perte de connexion WS.
	// L'agent n'a pas de reconnexion in-process : sur déconnexion réelle, on
	// sort proprement et systemd relance (Restart=always, RestartSec=10).
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	select {
	case <-sigCh:
		log.Println("[Agent] Shutting down...")
		client.Close()
	case <-client.Done():
		log.Println("[Agent] Connection lost — exiting for systemd restart")
		sdNotify("STOPPING=1")
		client.Close()
		os.Exit(1)
	}
}

func handleMessage(msg transport.Message, client *transport.Client, sandbox *security.Sandbox, cfg *config.Config, keystore *security.Keystore) {
	// Gate de version de protocole (fondation v2) : tout message serveur DOIT
	// porter v == ProtocolVersion, sinon il est rejeté ici, avant tout traitement.
	//
	// EXCEPTION UNIQUE ET VOLONTAIRE : TypeError. C'est le canal par lequel le
	// backend renvoie le message expliquant un rejet de version — exiger v2 dessus
	// serait circulaire (l'agent ne pourrait pas recevoir l'explication de son
	// propre rejet v1). Aucune autre exception : tout autre type (y compris
	// TypePing, aujourd'hui non émis par le backend) est gaté, par DÉCISION — on
	// ferme la porte gratuitement plutôt que de dépendre de « ce chemin ne fait
	// rien aujourd'hui », qui casse à la prochaine évolution. Quiconque ajoute un
	// handler ci-dessous verra ce gate et son unique exception justifiée.
	if msg.Type != transport.TypeError && msg.V != security.ProtocolVersion {
		log.Printf("[Agent] Rejected %q: unsupported protocol version %d (expected %d) — re-enroll",
			msg.Type, msg.V, security.ProtocolVersion)
		return
	}

	switch msg.Type {
	case transport.TypeActionRequest:
		// SECURITE CRITIQUE : action.request dispatche TOUTES les actions
		// mutantes (script.execute, package.install, user.create, firewall...).
		// On exige la meme verification que action.confirm — signature ECDSA du
		// backend + timestamp + nonce (anti-replay) — AVANT tout dechiffrement
		// ou dispatch. Sans cela, une trame chiffree capturee serait rejouable
		// dans la fenetre de validite, et l'authenticite ne reposerait que sur
		// le secret AES symetrique (que l'agent possede aussi) au lieu de la cle
		// publique du serveur. Le backend signe deja ce message.
		if serverPublicKey == nil {
			log.Printf("[Agent] Rejected action.request: server public key not configured")
			return
		}
		if err := security.VerifyServerMessage(security.VerifyServerMessageInput{
			V:         msg.V,
			Type:      msg.Type,
			RequestID: msg.RequestID,
			MachineID: msg.MachineID,
			Timestamp: msg.Timestamp,
			Nonce:     msg.Nonce,
			Payload:   msg.Payload,
			Signature: msg.Signature,
		}, serverPublicKey); err != nil {
			log.Printf("[Agent] Rejected action.request (request_id=%s): %v", msg.RequestID, err)
			return
		}
		go handleActionRequest(msg, client, sandbox, keystore)

	case transport.TypeActionConfirm:
		// Confirmation d'une action firewall/netplan (watchdog-revert).
		// SECURITE CRITIQUE : verifier signature + timestamp + nonce avant de
		// dispatcher, sinon un attaquant reseau pourrait forger un confirm
		// pour annuler le watchdog et laisser une regle dangereuse appliquee.
		if serverPublicKey == nil {
			log.Printf("[Agent] Rejected action.confirm: server public key not configured")
			return
		}
		if err := security.VerifyServerMessage(security.VerifyServerMessageInput{
			V:         msg.V,
			Type:      msg.Type,
			RequestID: msg.RequestID,
			MachineID: msg.MachineID,
			Timestamp: msg.Timestamp,
			Nonce:     msg.Nonce,
			Payload:   msg.Payload,
			Signature: msg.Signature,
		}, serverPublicKey); err != nil {
			log.Printf("[Agent] Rejected action.confirm (request_id=%s): %v", msg.RequestID, err)
			return
		}
		// On dispatch selon le prefix du request_id
		if strings.HasPrefix(msg.RequestID, "netplan-") {
			actions.HandleNetplanConfirm(msg.RequestID)
		} else if strings.HasPrefix(msg.RequestID, "sshd-") {
			actions.HandleSshdConfirm(msg.RequestID)
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
	// Déchiffrement avec la clé de SESSION (K du handshake ECDHE, mémoire seule),
	// pas un secret persisté.
	sessionKey := client.SessionKey()
	if sessionKey == nil {
		log.Printf("[Agent] Rejected action.request: no session key (handshake incomplete)")
		return
	}

	decrypted, err := security.DecryptAES(msg.Payload, sessionKey)
	if err != nil {
		log.Printf("[Agent] Failed to decrypt action request: %v", err)
		return
	}

	var request transport.ActionRequestPayload
	if err := json.Unmarshal([]byte(decrypted), &request); err != nil {
		log.Printf("[Agent] Failed to parse action request: %v", err)
		return
	}

	// Filet de sécurité : un panic dans Validate/Execute d'une action ne doit
	// JAMAIS faire tomber tout le process (sinon 10s d'indispo via restart
	// systemd + perte du cache d'idempotence + des timers watchdog en cours).
	// On renvoie une erreur propre et on libère la réservation d'idempotence.
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[Agent] PANIC dans l'action %s (request_id=%s): %v", request.ActionID, request.RequestID, r)
			sendActionResponse(client, request.RequestID, request.ActionID, false, nil, fmt.Sprintf("internal agent error: %v", r))
		}
	}()

	log.Printf("[Agent] Action request: %s (request_id: %s)", request.ActionID, request.RequestID)

	// Idempotence : ne jamais ré-exécuter un request_id déjà traité.
	if cached, dup := idemReserve(request.RequestID); dup {
		if cached != nil {
			log.Printf("[Agent] request_id=%s déjà traité — renvoi de la réponse mémorisée (pas de ré-exécution)", request.RequestID)
			if err := client.SendSigned(transport.TypeActionResponse, request.RequestID, cached); err != nil {
				log.Printf("[Agent] Failed to resend cached action response: %v", err)
			}
		} else {
			log.Printf("[Agent] request_id=%s en cours de traitement — duplicata ignoré", request.RequestID)
		}
		return
	}

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

	// Mémoriser la réponse pour l'idempotence (renvoyée telle quelle si le même
	// request_id est redélivré, sans ré-exécuter l'action).
	idemComplete(requestID, response)

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
		// SHA256 du binaire en cours d'exécution : permet au backend de
		// savoir de façon fiable si l'agent tourne la dernière version servie
		// (et donc de confirmer une self-upgrade après reconnexion).
		"agent_sha256": selfSHA256(),
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
