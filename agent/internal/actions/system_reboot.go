package actions

import (
	"log"
	"os/exec"
	"time"
)

func init() { Register(&SystemRebootAction{}) }

// SystemRebootAction triggers a reboot of the machine.
// The action returns ACK before the agent is killed by the reboot.
type SystemRebootAction struct{}

func (a *SystemRebootAction) ID() string         { return "system.reboot" }
func (a *SystemRebootAction) Capability() string { return "system_control" }

func (a *SystemRebootAction) Validate(params map[string]interface{}) error {
	return nil // no params required
}

func (a *SystemRebootAction) Execute(params map[string]interface{}) (interface{}, error) {
	// Launch the reboot in the background after a short delay
	// so that the ACK can be sent to the backend before death
	go func() {
		time.Sleep(2 * time.Second)
		log.Println("[Reboot] Executing sudo systemctl reboot")
		if err := exec.Command("/usr/bin/sudo", "/usr/bin/systemctl", "reboot").Run(); err != nil {
			log.Printf("[Reboot] Failed: %v", err)
		}
	}()

	return map[string]interface{}{
		"success":       true,
		"reboot_in_sec": 2,
		"message":       "Reboot scheduled. Machine will restart in 2 seconds.",
	}, nil
}
