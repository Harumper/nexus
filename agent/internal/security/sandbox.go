package security

import (
	"fmt"
	"sync"
)

// Action est l'interface que chaque action whitelistée doit implémenter
type Action interface {
	ID() string
	Capability() string
	Validate(params map[string]interface{}) error
	Execute(params map[string]interface{}) (interface{}, error)
}

// Sandbox vérifie que les actions sont autorisées par les capabilities
type Sandbox struct {
	mu           sync.RWMutex
	capabilities map[string]bool // set de capabilities actives
}

func NewSandbox() *Sandbox {
	return &Sandbox{
		capabilities: make(map[string]bool),
	}
}

// SetCapabilities remplace toutes les capabilities
func (s *Sandbox) SetCapabilities(caps []string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.capabilities = make(map[string]bool)
	for _, c := range caps {
		s.capabilities[c] = true
	}
}

// CanExecute vérifie si une action est autorisée
func (s *Sandbox) CanExecute(action Action) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.capabilities[action.Capability()]
}

// GetCapabilities retourne la liste des capabilities actives
func (s *Sandbox) GetCapabilities() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	caps := make([]string, 0, len(s.capabilities))
	for c := range s.capabilities {
		caps = append(caps, c)
	}
	return caps
}

// ValidateAndExecute vérifie la capability, valide les params, puis exécute
func (s *Sandbox) ValidateAndExecute(action Action, params map[string]interface{}) (interface{}, error) {
	if !s.CanExecute(action) {
		return nil, fmt.Errorf("capability '%s' is not granted for action '%s'", action.Capability(), action.ID())
	}

	if err := action.Validate(params); err != nil {
		return nil, fmt.Errorf("validation failed for action '%s': %w", action.ID(), err)
	}

	return action.Execute(params)
}
