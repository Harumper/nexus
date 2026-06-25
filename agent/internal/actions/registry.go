package actions

import (
	"fmt"
	"sync"

	"github.com/nexus/agent/internal/security"
)

var (
	mu       sync.RWMutex
	registry = make(map[string]security.Action)
)

// probeMode reflète si l'agent tourne en mode PROBE (lecture seule). Mis à jour
// par main.go quand le type de machine est connu. Les actions whitelistées PROBE
// qui auraient un effet de bord (ex. security.audit installant lynis via apt)
// doivent consulter ce flag pour rester strictement en lecture seule.
var probeMode bool

// SetProbeMode est appelé par main.go quand le type d'agent est déterminé.
func SetProbeMode(v bool) { probeMode = v }

// IsProbeMode renvoie true si l'agent est en mode PROBE (lecture seule).
func IsProbeMode() bool { return probeMode }

// Register enregistre une action dans le registre
// Appelé dans les init() de chaque fichier d'action
func Register(action security.Action) {
	mu.Lock()
	defer mu.Unlock()
	id := action.ID()
	if _, exists := registry[id]; exists {
		panic(fmt.Sprintf("duplicate action registration: %s", id))
	}
	registry[id] = action
}

// Get retourne une action par son ID
func Get(actionID string) (security.Action, bool) {
	mu.RLock()
	defer mu.RUnlock()
	a, ok := registry[actionID]
	return a, ok
}

// ListAll retourne tous les IDs d'actions enregistrées
func ListAll() []string {
	mu.RLock()
	defer mu.RUnlock()
	ids := make([]string, 0, len(registry))
	for id := range registry {
		ids = append(ids, id)
	}
	return ids
}
