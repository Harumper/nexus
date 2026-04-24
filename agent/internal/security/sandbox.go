package security

import (
	"fmt"
)

// Action est l'interface que chaque action whitelistée doit implémenter
type Action interface {
	ID() string
	Capability() string
	Validate(params map[string]interface{}) error
	Execute(params map[string]interface{}) (interface{}, error)
}

// Sandbox valide puis execute une action. Le controle d'acces (PROBE vs AGENT)
// est applique cote backend (dispatcher) et cote agent via la whitelist
// probeAllowedActions dans main.go.
type Sandbox struct{}

func NewSandbox() *Sandbox {
	return &Sandbox{}
}

// ValidateAndExecute valide les params puis execute
func (s *Sandbox) ValidateAndExecute(action Action, params map[string]interface{}) (interface{}, error) {
	if err := action.Validate(params); err != nil {
		return nil, fmt.Errorf("validation failed for action '%s': %w", action.ID(), err)
	}
	return action.Execute(params)
}
