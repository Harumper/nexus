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

// AgentSudoersCheckAction reads the sudoers file via sudo cat (the file
// is root:root 0440, the agent cannot read it directly) and returns
// its SHA256. The backend compares it against its reference version to detect
// whether the agent needs to be reinstalled (sudoers drift after adding new
// actions).
//
// Detection only: no write on the agent side. The update remains
// manual via re-running install-agent.sh by the SSH admin.
type AgentSudoersCheckAction struct{}

func (a *AgentSudoersCheckAction) ID() string                              { return "agent.sudoers_check" }
func (a *AgentSudoersCheckAction) Capability() string                      { return "monitoring" }
func (a *AgentSudoersCheckAction) Validate(_ map[string]interface{}) error { return nil }

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

// computeSudoersHash is used at agent startup to cache the
// hash and include it in the heartbeat (avoids a sudo call on every
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

// SudoersHash returns the cached SHA256 (computed at agent startup).
// Empty if the file is not found or sudo fails.
var cachedSudoersHash string

func init() {
	cachedSudoersHash = computeSudoersHash()
}

func GetSudoersHash() string {
	return cachedSudoersHash
}
