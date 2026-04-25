package actions

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os/exec"
	"strings"
)

func init() {
	Register(&AgentSudoersCheckAction{})
}

// AgentSudoersCheckAction lit le fichier sudoers via sudo cat (le fichier
// est root:root 0440, l'agent ne peut pas le lire directement) et retourne
// son SHA256. Le backend compare avec sa version de reference pour detecter
// si l'agent doit etre reinstalle (drift sudoers apres ajout de nouvelles
// actions).
//
// Detection seule : aucune ecriture cote agent. La mise a jour reste
// manuelle via re-execution de install-agent.sh par l'admin SSH.
type AgentSudoersCheckAction struct{}

func (a *AgentSudoersCheckAction) ID() string                                 { return "agent.sudoers_check" }
func (a *AgentSudoersCheckAction) Capability() string                         { return "monitoring" }
func (a *AgentSudoersCheckAction) Validate(_ map[string]interface{}) error    { return nil }

func (a *AgentSudoersCheckAction) Execute(_ map[string]interface{}) (interface{}, error) {
	cmd := exec.Command("sudo", "-n", "/bin/cat", "/etc/sudoers.d/nexus-agent")
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("read sudoers: %w", err)
	}
	hash := sha256.Sum256(out)
	return map[string]interface{}{
		"hash":  hex.EncodeToString(hash[:]),
		"lines": strings.Count(string(out), "\n"),
		"size":  len(out),
	}, nil
}

// computeSudoersHash est utilise au demarrage de l'agent pour cacher le
// hash et l'inclure dans le heartbeat (evite un appel sudo a chaque
// heartbeat).
func computeSudoersHash() string {
	cmd := exec.Command("sudo", "-n", "/bin/cat", "/etc/sudoers.d/nexus-agent")
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	hash := sha256.Sum256(out)
	return hex.EncodeToString(hash[:])
}

// SudoersHash retourne le SHA256 cache (calcule au demarrage agent).
// Vide si le fichier est introuvable ou sudo echoue.
var cachedSudoersHash string

func init() {
	cachedSudoersHash = computeSudoersHash()
}

func GetSudoersHash() string {
	return cachedSudoersHash
}
