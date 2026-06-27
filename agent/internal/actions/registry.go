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
