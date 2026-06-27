package actions

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// NEXUS-SELF-UPGRADE-005 — watchdog-revert appliqué à l'auto-upgrade (le seul
// mutateur self qui sautait le pattern snapshot→apply→revert-si-non-confirmé de
// firewall/netplan/sshd). Une release valide-mais-mauvaise ne doit pas bricker
// l'hôte sans retour.
//
// Flow :
//  1. avant d'installer le nouveau binaire : snapshot du courant → .prev (root) ;
//  2. après install : marqueur "upgrade en attente" (SHA attendu) ;
//  3. au boot (RecoverPendingUpgrade) : si un marqueur existe et que le binaire
//     courant est bien le nouveau, on ARME un dead-man's switch — si l'agent ne
//     CONFIRME pas (reconnexion + auth) sous le délai, on restaure .prev et on
//     redémarre sur le binaire connu-bon ;
//  4. ConfirmUpgrade (appelé sur reconnexion réussie) annule le switch + efface
//     le marqueur. On NE supprime PAS .prev (fallback conservé, écrasé au prochain
//     upgrade).
const (
	prevBinPath       = "/var/lib/nexus-agent/nexus-agent.prev"
	upgradeMarkerPath = "/var/lib/nexus-agent/upgrade-pending"
	agentFinalBinPath = "/usr/local/bin/nexus-agent"
	upgradeGrace      = 180 * time.Second
)

var (
	upgradeMu          sync.Mutex
	upgradeRevertTimer *time.Timer
)

func fileSHA256(path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:]), nil
}

// snapshotPreviousBinary copie le binaire courant en .prev (root-owned) AVANT
// l'écrasement — on ne supprime jamais la seule copie de secours.
func snapshotPreviousBinary() error {
	out, err := exec.Command("/usr/bin/sudo", "/usr/bin/install", "-m", "755", agentFinalBinPath, prevBinPath).CombinedOutput()
	if err != nil {
		return fmt.Errorf("snapshot .prev: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// markUpgradePending écrit le marqueur (SHA attendu du nouveau binaire).
func markUpgradePending(expectedSHA string) error {
	return os.WriteFile(upgradeMarkerPath, []byte(expectedSHA+"\n"), 0600)
}

// RecoverPendingUpgrade — appelé au BOOT (comme RecoverPendingSnapshots/Netplan/
// Sshd). Arme le dead-man's switch si une upgrade est en attente.
func RecoverPendingUpgrade() {
	data, err := os.ReadFile(upgradeMarkerPath)
	if err != nil {
		return // pas d'upgrade en attente
	}
	expected := strings.TrimSpace(string(data))

	cur, err := fileSHA256(agentFinalBinPath)
	if err == nil && cur != expected {
		// Le binaire courant n'est PAS le nouveau attendu → restaurer le connu-bon.
		log.Printf("[Upgrade] binaire courant ≠ attendu (%s ≠ %s) → restauration .prev", cur, expected)
		revertUpgrade()
		return
	}

	upgradeMu.Lock()
	upgradeRevertTimer = time.AfterFunc(upgradeGrace, func() {
		log.Printf("[Upgrade] pas de confirmation sous %v → restauration .prev (dead-man's switch)", upgradeGrace)
		revertUpgrade()
	})
	upgradeMu.Unlock()
	log.Printf("[Upgrade] nouveau binaire démarré ; health-gate armé (%v jusqu'à confirmation)", upgradeGrace)
}

// ConfirmUpgrade — appelé sur reconnexion + auth réussie. Annule le switch et
// efface le marqueur : l'upgrade est validé.
func ConfirmUpgrade() {
	upgradeMu.Lock()
	if upgradeRevertTimer != nil {
		upgradeRevertTimer.Stop()
		upgradeRevertTimer = nil
	}
	upgradeMu.Unlock()
	if _, err := os.Stat(upgradeMarkerPath); err == nil {
		os.Remove(upgradeMarkerPath)
		log.Printf("[Upgrade] confirmé (reconnexion OK) ; marqueur effacé (.prev conservé comme fallback)")
	}
}

// revertUpgrade restaure le binaire de secours .prev et redémarre.
func revertUpgrade() {
	if _, err := os.Stat(prevBinPath); err != nil {
		log.Printf("[Upgrade] .prev absent — revert impossible")
		return
	}
	out, err := exec.Command("/usr/bin/sudo", "/usr/bin/install", "-m", "755", prevBinPath, agentFinalBinPath).CombinedOutput()
	if err != nil {
		log.Printf("[Upgrade] revert install échoué: %v %s", err, strings.TrimSpace(string(out)))
		return
	}
	os.Remove(upgradeMarkerPath)
	log.Printf("[Upgrade] binaire restauré depuis .prev → redémarrage sur le connu-bon")
	os.Exit(1) // Restart=always relance l'agent sur le binaire restauré
}
