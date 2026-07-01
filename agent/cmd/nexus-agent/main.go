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

// selfSHA256 returns the SHA256 (hex) of the currently running agent binary,
// computed only once. Used by the backend to compare the installed version
// against the one it serves ("up-to-date" detection + upgrade completion).
var (
	selfSHAOnce  sync.Once
	selfSHAValue string
)

// ===================== Action idempotency =====================
// A given request_id must NEVER be re-executed: a re-dispatch (or a WS
// redelivery of the same frame after a lost ack) would replay a destructive
// mutation (reboot, apt remove, user.create...). We memorize processed
// request_ids + their response to return the result without re-executing.
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

// idemReserve reserves a request_id for execution. Returns (memorized response,
// isDuplicate). If it's a duplicate and execution is done, the response is non-nil.
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

// idemComplete records the final response for a reserved request_id.
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

// notifySocket: path of the systemd socket captured once at boot.
// We REMOVE NOTIFY_SOCKET from the environment (initSystemdNotify) so it is
// NOT inherited by child processes (lynis, apt, systemctl…): otherwise those
// children write to the socket and systemd floods the journal with
// "Got notification message from PID X, but reception only permitted for main PID".
// (Equivalent to sd_notify's unset_environment flag.)
var notifySocket string

func initSystemdNotify() {
	notifySocket = os.Getenv("NOTIFY_SOCKET")
	if notifySocket != "" {
		os.Unsetenv("NOTIFY_SOCKET")
	}
}

// sdNotify sends a message to the service manager (systemd) via the socket
// captured at boot. No-op outside systemd. Handles abstract sockets (@ -> NUL).
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

// runWatchdog notifies systemd (WATCHDOG=1) at half the WatchdogSec interval.
// WITHOUT this, the unit `WatchdogSec=120` caused the agent to be killed+
// restarted every 120s (hence the periodic disconnections observed). No-op if
// the watchdog is not enabled (WATCHDOG_USEC absent).
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
	// Version is injected at build via -ldflags "-X main.Version=...".
	// "dev" = binary compiled without stamping (local build).
	Version = "dev"

	// serverPublicKey is the backend's ECDSA public key, parsed once at boot
	// and used to verify server messages (action.confirm).
	serverPublicKey *ecdsa.PublicKey
)

func main() {
	// NEXUS-AGENT-003/008 — privhelper mode (COMPILED root wrapper): invoked via
	// `sudo nexus-agent privhelper <op> …`, it runs a strictly validated
	// privileged operation then exits. BEFORE everything else (no config, no
	// systemd notify): it's a short-lived root subprocess, not the agent.
	if len(os.Args) >= 2 && os.Args[1] == "privhelper" {
		os.Exit(privhelper.Run(os.Args[2:]))
	}

	// `--version`: used by the auto-upgrade to tie the version to the artifact
	// (SELF-UPGRADE-002). Prints the version injected at build and exits.
	if len(os.Args) >= 2 && os.Args[1] == "--version" {
		fmt.Println(Version)
		os.Exit(0)
	}
	actions.RunningVersion = Version

	log.SetFlags(log.LstdFlags | log.Lshortfile)

	// Capture NOTIFY_SOCKET and remove it from the env BEFORE launching any
	// subprocess, so as not to leak it to children (otherwise journal flood).
	initSystemdNotify()

	// Load the configuration
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}
	cfg.Version = Version
	// Pinned origin for the auto-upgrade (SELF-UPGRADE-003).
	actions.PinnedServerURL = cfg.ServerURL

	log.Printf("[Nexus Agent] Version %s starting...", Version)

	// Parse the server's public key once at boot. Used to verify action.confirm
	// messages (firewall/netplan watchdog cancellation).
	// STRICT PINNING (isolation between projects): the server's public key is
	// MANDATORY. Without it, any backend could drive this agent (and
	// action.request/action.confirm would be rejected anyway). We therefore fail
	// at boot rather than run in an unusable state.
	if cfg.ServerPublicKey == "" {
		log.Fatal("[Agent] FATAL: no server public key configured (NEXUS_SERVER_PUBLIC_KEY_FILE). " +
			"It is mandatory to authenticate the backend and isolate the agent. " +
			"Re-enroll the agent with --server-public-key-file (UI: Re-enroll button).")
	}
	parsedServerKey, err := security.ParsePublicKeyPEM(cfg.ServerPublicKey)
	if err != nil {
		log.Fatalf("Failed to parse server public key: %v", err)
	}
	serverPublicKey = parsedServerKey

	// Dead man's switch: if the agent crashed during a change (firewall/netplan),
	// revert all pending snapshots at startup
	actions.RecoverPendingSnapshots()
	actions.RecoverPendingNetplan()
	actions.RecoverPendingSshd()
	actions.RecoverPendingUpgrade() // SELF-UPGRADE-005: dead-man's switch for the auto-upgrade

	// Periodic cleanup of the fs.upload inbox (files > 7d). Once at boot then
	// every 24h. Not critical if missed (files will be picked up on the next
	// tick), so a non-blocking goroutine.
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

	// Initialize the keystore
	keystore := security.NewKeystore(cfg.KeyPath)
	sandbox := security.NewSandbox()

	// Create the WebSocket client
	client := transport.NewClient(cfg.ServerURL, cfg.MachineID)

	// Connect to the server
	log.Printf("[Agent] Connecting to %s...", cfg.ServerURL)
	if err := client.Connect(); err != nil {
		log.Fatalf("Failed to connect: %v", err)
	}

	// Enrollment if needed (identity = agent.key + enrollment marker; the AES
	// session key is no longer persisted — cf. handshake below).
	if !keystore.IsEnrolled() {
		if cfg.EnrollmentToken == "" {
			log.Fatal("Not enrolled and no enrollment token provided. Cannot authenticate.")
		}

		// Start reading in the background to receive the enrollment response
		go client.ReadLoop()

		if err := security.Enroll(
			client.SendRaw,
			client.ReceiveRaw,
			cfg.MachineID,
			cfg.EnrollmentToken,
			cfg.ServerPublicKey,
			keystore,
		); err != nil {
			log.Fatalf("Enrollment failed: %v", err)
		}

		// After enrollment, reconnect for a clean stream (new WS).
		log.Println("[Agent] Reconnecting after enrollment...")
		client.Close()
		time.Sleep(1 * time.Second)
		client = transport.NewClient(cfg.ServerURL, cfg.MachineID)
		if err := client.Connect(); err != nil {
			log.Fatalf("Failed to reconnect: %v", err)
		}
	} else {
		// Load the existing long-term identity
		if err := keystore.Load(); err != nil {
			log.Fatalf("Failed to load keys: %v", err)
		}
	}

	// ECDHE X25519 handshake (forward secrecy): derives the session key K IN
	// MEMORY over the established connection. Replaces the old persisted shared
	// secret. At startup, sharedSecret=nil → session.hello is signed but NOT
	// encrypted. The agent exits/restarts on connection loss (systemd restarts)
	// → a new ephemeral K is negotiated on each connection.
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

	// SELF-UPGRADE-005 — reconnection + auth succeeded: confirm any pending
	// upgrade (cancels the dead-man's switch, keeps the new binary).
	actions.ConfirmUpgrade()

	log.Printf("[Agent] Authenticated")
	log.Printf("[Agent] Registered actions: %v", actions.ListAll())

	// Wire the progress callback for system updates (apt)
	actions.OnUpdateProgress = func(line string, percent int) {
		client.SendSigned(transport.TypeUpdateProgress, "", map[string]interface{}{
			"line":    line,
			"percent": percent,
		})
	}

	// Wire the progress callback for the agent's own upgrade.
	// Distinct channel: the frontend follows this in a dedicated modal until the
	// restart, then detects the reconnection via the heartbeat SHA.
	actions.OnAgentUpgradeProgress = func(line string, percent int) {
		client.SendSigned(transport.TypeAgentUpgradeProgress, "", map[string]interface{}{
			"line":    line,
			"percent": percent,
		})
	}

	// Security audit progress (Lynis) — live console on the UI side.
	actions.OnSecurityProgress = func(line string, percent int) {
		client.SendSigned(transport.TypeSecurityProgress, "", map[string]interface{}{
			"line":    line,
			"percent": percent,
		})
	}

	// Handler for incoming messages. The read loop (ReadLoop) was already started
	// before the handshake; we only wire the business dispatcher here.
	client.OnMessage(func(msg transport.Message) {
		handleMessage(msg, client, sandbox, cfg, keystore)
	})

	// Start the heartbeat
	go runHeartbeat(client, cfg)

	// Start metrics collection
	go runMetrics(client, cfg)

	// Notify systemd that the service is ready + maintain the watchdog
	// (WatchdogSec in the unit). Without this, systemd kills the agent periodically.
	sdNotify("READY=1")
	go runWatchdog()

	log.Println("[Agent] Running. Waiting for signals...")

	// Wait for either a shutdown signal or the loss of the WS connection.
	// The agent has no in-process reconnection: on a real disconnection, we exit
	// cleanly and systemd restarts (Restart=always, RestartSec=10).
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
	// Protocol version gate (v2 foundation): every server message MUST carry
	// v == ProtocolVersion, otherwise it is rejected here, before any processing.
	//
	// SINGLE AND DELIBERATE EXCEPTION: TypeError. It's the channel through which
	// the backend returns the message explaining a version rejection — requiring
	// v2 on it would be circular (the agent could not receive the explanation of
	// its own v1 rejection). No other exception: any other type (including
	// TypePing, not emitted by the backend today) is gated, by DECISION — we
	// close the door for free rather than depend on "this path does nothing
	// today", which breaks at the next evolution. Whoever adds a handler below
	// will see this gate and its single justified exception.
	if msg.Type != transport.TypeError && msg.V != security.ProtocolVersion {
		log.Printf("[Agent] Rejected %q: unsupported protocol version %d (expected %d) — re-enroll",
			msg.Type, msg.V, security.ProtocolVersion)
		return
	}

	switch msg.Type {
	case transport.TypeActionRequest:
		// CRITICAL SECURITY: action.request dispatches ALL mutating actions
		// (script.execute, package.install, user.create, firewall...). We require
		// the same verification as action.confirm — backend ECDSA signature +
		// timestamp + nonce (anti-replay) — BEFORE any decryption or dispatch.
		// Without it, a captured encrypted frame would be replayable within the
		// validity window, and authenticity would rest only on the symmetric AES
		// secret (which the agent also holds) instead of the server's public key.
		// The backend already signs this message.
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
		// Confirmation of a firewall/netplan action (watchdog-revert).
		// CRITICAL SECURITY: verify signature + timestamp + nonce before
		// dispatching, otherwise a network attacker could forge a confirm to
		// cancel the watchdog and leave a dangerous rule applied.
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
		// Dispatch based on the request_id prefix
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
	// Decryption with the SESSION key (K from the ECDHE handshake, memory only),
	// not a persisted secret.
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

	// Safety net: a panic in an action's Validate/Execute must NEVER bring down
	// the whole process (otherwise 10s of downtime via systemd restart + loss of
	// the idempotency cache + of in-flight watchdog timers). We return a clean
	// error and release the idempotency reservation.
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[Agent] PANIC in action %s (request_id=%s): %v", request.ActionID, request.RequestID, r)
			sendActionResponse(client, request.RequestID, request.ActionID, false, nil, fmt.Sprintf("internal agent error: %v", r))
		}
	}()

	log.Printf("[Agent] Action request: %s (request_id: %s)", request.ActionID, request.RequestID)

	// Idempotency: never re-execute an already-processed request_id.
	if cached, dup := idemReserve(request.RequestID); dup {
		if cached != nil {
			log.Printf("[Agent] request_id=%s already processed — returning memorized response (no re-execution)", request.RequestID)
			if err := client.SendSigned(transport.TypeActionResponse, request.RequestID, cached); err != nil {
				log.Printf("[Agent] Failed to resend cached action response: %v", err)
			}
		} else {
			log.Printf("[Agent] request_id=%s in progress — duplicate ignored", request.RequestID)
		}
		return
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

	// Memorize the response for idempotency (returned as-is if the same
	// request_id is redelivered, without re-executing the action).
	idemComplete(requestID, response)

	if err := client.SendSigned(transport.TypeActionResponse, requestID, response); err != nil {
		log.Printf("[Agent] Failed to send action response: %v", err)
	}
}

func runHeartbeat(client *transport.Client, cfg *config.Config) {
	ticker := time.NewTicker(time.Duration(cfg.HeartbeatInterval) * time.Second)
	defer ticker.Stop()

	// Send immediately
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
		"reboot_required": rebootRequired,
		"sudoers_hash":    actions.GetSudoersHash(),
		// SHA256 of the currently running binary: lets the backend reliably know
		// whether the agent is running the latest served version (and thus
		// confirm a self-upgrade after reconnection).
		"agent_sha256": selfSHA256(),
	}
	if err := client.SendSigned(transport.TypeHeartbeat, "", data); err != nil {
		log.Printf("[Agent] Failed to send heartbeat: %v", err)
	}
}

func runMetrics(client *transport.Client, cfg *config.Config) {
	// Wait a bit before the first collection
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
