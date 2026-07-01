package security

import (
	"fmt"
)

// Action is the interface that each whitelisted action must implement
type Action interface {
	ID() string
	Capability() string
	Validate(params map[string]interface{}) error
	Execute(params map[string]interface{}) (interface{}, error)
}

// Sandbox validates then executes an action. Access control (user role,
// isCritical, privileged actions) is enforced on the backend side (dispatcher);
// the agent's root capability is defined by the sudoers generated at install.
type Sandbox struct{}

func NewSandbox() *Sandbox {
	return &Sandbox{}
}

// ValidateAndExecute validates the params then executes
func (s *Sandbox) ValidateAndExecute(action Action, params map[string]interface{}) (interface{}, error) {
	if err := action.Validate(params); err != nil {
		return nil, fmt.Errorf("validation failed for action '%s': %w", action.ID(), err)
	}
	return action.Execute(params)
}
