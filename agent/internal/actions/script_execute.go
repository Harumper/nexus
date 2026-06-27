package actions

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log"
	"os"
	"os/exec"
	"time"

	"github.com/nexus/agent/internal/security"
)

// scriptSigningPubKeyPath : clé(s) publique(s) minisign DÉDIÉE(S) à la signature
// de script (verrou indépendant du canal), déposée(s) par l'opérateur à
// l'installation (root:root 0644). Distincte de la clé serveur pinnée (canal) et
// de la clé de release (binaire) : keypair propre, révocable indépendamment.
const scriptSigningPubKeyPath = "/etc/nexus/script-signing.pub"

func init() { Register(&ScriptExecuteAction{}) }

type ScriptExecuteAction struct{}

func (a *ScriptExecuteAction) ID() string        { return "script.execute" }
func (a *ScriptExecuteAction) Capability() string { return "scripts" }

func (a *ScriptExecuteAction) Validate(params map[string]interface{}) error {
	script, ok := params["script"].(string)
	if !ok || script == "" {
		return fmt.Errorf("required parameter 'script' missing")
	}
	if len(script) > 10240 {
		return fmt.Errorf("script too large (max 10 KB)")
	}
	return nil
}

func (a *ScriptExecuteAction) Execute(params map[string]interface{}) (interface{}, error) {
	script := params["script"].(string)
	scriptSig, _ := params["script_sig"].(string)

	// ---- VERROU INDÉPENDANT DU CANAL : signature de script ----
	// On vérifie une signature minisign détachée des octets EXACTS du script
	// (avant tout ajout de shebang) contre une accept-list LOCALE déposée par
	// l'opérateur. Le backend relaie `script_sig` mais ne détient pas la clé
	// privée hors-ligne → un canal compromis ne peut pas injecter de script.
	// Fail-closed : clé absente/illisible/vide, signature absente ou invalide
	// ⇒ refus, AVANT toute écriture sur disque ou exécution.
	keys, err := security.LoadMinisignAcceptList(scriptSigningPubKeyPath)
	if err != nil {
		return nil, fmt.Errorf("clé de signature de script absente/invalide : exécution refusée : %w", err)
	}
	sigOK, signerID := false, uint64(0)
	if scriptSig != "" {
		sigOK, signerID = security.VerifyMinisignAny(keys, []byte(script), []byte(scriptSig))
	}
	if !sigOK {
		return nil, fmt.Errorf("script signature invalid — refusing to execute")
	}

	// Audit append-only : journald (store root:systemd-journal ; nexus-agent y a
	// un accès LECTURE seule → peut émettre mais pas réécrire/tronquer le passé).
	// Le principal (utilisateur web) est journalisé côté backend (AuditLog).
	scriptHash := sha256.Sum256([]byte(script))
	log.Printf("AUDIT script.execute hash=%s signer_keyid=%016x bytes=%d",
		hex.EncodeToString(scriptHash[:]), signerID, len(script))

	timeoutSec := 30
	if t, ok := params["timeout"].(float64); ok && t > 0 {
		timeoutSec = int(t)
	}
	if timeoutSec > 300 {
		timeoutSec = 300 // Max 5 minutes
	}

	// Write script to dedicated state directory (not world-writable /tmp)
	// Created by systemd via StateDirectory=nexus-agent
	scriptDir := "/var/lib/nexus-agent"
	os.MkdirAll(scriptDir, 0700)
	tmpFile, err := os.CreateTemp(scriptDir, "nexus-script-*.sh")
	if err != nil {
		return nil, fmt.Errorf("failed to create temp file: %w", err)
	}
	defer os.Remove(tmpFile.Name())

	if _, err := tmpFile.WriteString("#!/bin/bash\nset -e\n" + script); err != nil {
		tmpFile.Close()
		return nil, fmt.Errorf("failed to write script: %w", err)
	}
	tmpFile.Close()

	if err := os.Chmod(tmpFile.Name(), 0700); err != nil {
		return nil, fmt.Errorf("failed to chmod script: %w", err)
	}

	// Execute with timeout
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutSec)*time.Second)
	defer cancel()

	// Via sudo — l'agent tourne sous nexus-agent (non-root)
	cmd := exec.CommandContext(ctx, "/usr/bin/sudo", "/bin/bash", tmpFile.Name())
	output, err := cmd.CombinedOutput()

	exitCode := 0
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			exitCode = exitErr.ExitCode()
		} else {
			exitCode = -1
		}
	}

	return map[string]interface{}{
		"success":   err == nil,
		"output":    string(output),
		"exit_code": exitCode,
	}, nil
}
