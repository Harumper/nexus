package modules

import (
	"fmt"

	"github.com/nexus/agent/internal/security"
)

// BridgeAction est une action de l'agent qui bridge vers un module externe
// Elle implémente l'interface security.Action et permet au sandbox
// de vérifier les capabilities avant de forwarder au module
type BridgeAction struct {
	actionID   string
	capability string
	loader     *Loader
}

func NewBridgeAction(actionID, capability string, loader *Loader) *BridgeAction {
	return &BridgeAction{
		actionID:   actionID,
		capability: capability,
		loader:     loader,
	}
}

func (a *BridgeAction) ID() string         { return a.actionID }
func (a *BridgeAction) Capability() string  { return a.capability }

func (a *BridgeAction) Validate(params map[string]interface{}) error {
	// Le module fait sa propre validation
	// Ici on vérifie juste que le module est disponible
	_, ok := a.loader.GetModuleForAction(a.actionID)
	if !ok {
		return fmt.Errorf("module for action '%s' is not available", a.actionID)
	}
	return nil
}

func (a *BridgeAction) Execute(params map[string]interface{}) (interface{}, error) {
	requestID, _ := params["request_id"].(string)
	return a.loader.ExecuteAction(a.actionID, requestID, params)
}

// RegisterModuleActions crée des BridgeAction pour toutes les actions d'un module
// et les enregistre dans le registre global de l'agent
func RegisterModuleActions(loader *Loader, register func(security.Action)) {
	for actionID, moduleName := range loader.GetAllActions() {
		module, ok := loader.GetModule(moduleName)
		if !ok {
			continue
		}
		bridge := NewBridgeAction(actionID, module.Info.Capability, loader)
		register(bridge)
	}
}
