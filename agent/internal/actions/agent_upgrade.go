package actions

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"time"
)

func init() { Register(&AgentUpgradeAction{}) }

// OnAgentUpgradeProgress est appelé à chaque étape de la mise à jour de
// l'agent (téléchargement, vérification, installation, redémarrage). Branché
// par main.go pour streamer la progression vers le backend (agent.upgrade.progress).
// Distinct de OnUpdateProgress (MAJ système apt) : contexte UI différent.
var OnAgentUpgradeProgress func(line string, percent int)

func upgradeProgress(line string, percent int) {
	if OnAgentUpgradeProgress != nil {
		OnAgentUpgradeProgress(line, percent)
	}
}

// AgentUpgradeAction met a jour le binaire de l'agent lui-meme.
// Flow :
//   1. Telecharge le nouveau binaire dans /var/lib/nexus-agent/nexus-agent.new
//   2. Verifie le SHA256 (si fourni)
//   3. sudo install -m 755 pour remplacer /usr/local/bin/nexus-agent
//   4. Retourne ACK
//   5. os.Exit(0) apres un bref delai
//   6. systemd (Restart=always) relance le service avec le nouveau binaire
type AgentUpgradeAction struct{}

func (a *AgentUpgradeAction) ID() string         { return "agent.upgrade" }
func (a *AgentUpgradeAction) Capability() string { return "monitoring" } // toujours disponible

func (a *AgentUpgradeAction) Validate(params map[string]interface{}) error {
	if _, ok := params["download_url"].(string); !ok {
		return fmt.Errorf("required parameter 'download_url' missing")
	}
	if _, ok := params["token"].(string); !ok {
		return fmt.Errorf("required parameter 'token' missing")
	}
	return nil
}

func (a *AgentUpgradeAction) Execute(params map[string]interface{}) (interface{}, error) {
	downloadURL := params["download_url"].(string)
	token := params["token"].(string)
	expectedSHA256, _ := params["sha256"].(string)

	newBinPath := "/var/lib/nexus-agent/nexus-agent.new"
	finalBinPath := "/usr/local/bin/nexus-agent"

	// S'assurer que le dossier existe (StateDirectory devrait l'avoir cree)
	os.MkdirAll("/var/lib/nexus-agent", 0700)

	// 1. Telecharger
	upgradeProgress("Téléchargement du nouveau binaire…", 10)
	url := downloadURL + "?token=" + token
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	client := &http.Client{Timeout: 2 * time.Minute}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("download failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("download failed: HTTP %d", resp.StatusCode)
	}

	out, err := os.Create(newBinPath)
	if err != nil {
		return nil, fmt.Errorf("create file: %w", err)
	}

	hasher := sha256.New()
	w := io.MultiWriter(out, hasher)
	written, err := io.Copy(w, resp.Body)
	out.Close()
	if err != nil {
		os.Remove(newBinPath)
		return nil, fmt.Errorf("write binary: %w", err)
	}

	actualSHA256 := hex.EncodeToString(hasher.Sum(nil))
	upgradeProgress(fmt.Sprintf("Téléchargé : %d octets", written), 45)

	// 2. Verifier le SHA256 si fourni
	upgradeProgress("Vérification de l'intégrité (SHA256)…", 55)
	if expectedSHA256 != "" && expectedSHA256 != actualSHA256 {
		os.Remove(newBinPath)
		return nil, fmt.Errorf("sha256 mismatch: expected %s, got %s", expectedSHA256, actualSHA256)
	}

	// chmod +x
	if err := os.Chmod(newBinPath, 0755); err != nil {
		return nil, fmt.Errorf("chmod: %w", err)
	}

	// 3. Remplacer le binaire actuel via sudo install (atomic)
	upgradeProgress("Installation du binaire (atomique)…", 75)
	cmd := exec.Command("/usr/bin/sudo", "/usr/bin/install", "-m", "755", newBinPath, finalBinPath)
	if output, err := cmd.CombinedOutput(); err != nil {
		return nil, fmt.Errorf("install failed: %w: %s", err, string(output))
	}

	// Nettoyer le fichier temporaire
	os.Remove(newBinPath)

	// 4. Lancer un exit differe (apres avoir retourne la reponse)
	// systemd va redemarrer l'agent (Restart=always) avec le nouveau binaire.
	upgradeProgress("Installé. Redémarrage de l'agent dans 2s…", 90)
	go func() {
		time.Sleep(2 * time.Second)
		os.Exit(0)
	}()

	return map[string]interface{}{
		"success":        true,
		"downloaded":     written,
		"sha256":         actualSHA256,
		"installed_to":   finalBinPath,
		"restart_in_sec": 2,
	}, nil
}
