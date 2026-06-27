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

// Sandbox valide puis execute une action. Le contrôle d'accès (rôle utilisateur,
// isCritical, actions privilégiées) est appliqué côté backend (dispatcher) ; la
// capacité root de l'agent est définie par le sudoers généré à l'install.
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
