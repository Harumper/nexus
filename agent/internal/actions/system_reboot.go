package actions

import (
	"log"
	"os/exec"
	"time"
)

func init() { Register(&SystemRebootAction{}) }

// SystemRebootAction déclenche un redémarrage de la machine.
// L'action retourne ACK avant que l'agent ne soit tué par le reboot.
type SystemRebootAction struct{}

func (a *SystemRebootAction) ID() string         { return "system.reboot" }
func (a *SystemRebootAction) Capability() string { return "system_control" }

func (a *SystemRebootAction) Validate(params map[string]interface{}) error {
	return nil // pas de params requis
}

func (a *SystemRebootAction) Execute(params map[string]interface{}) (interface{}, error) {
	// Lance le reboot en background après un court délai
	// pour que l'ACK puisse être envoyé au backend avant la mort
	go func() {
		time.Sleep(2 * time.Second)
		log.Println("[Reboot] Executing sudo systemctl reboot")
		if err := exec.Command("/usr/bin/sudo", "/usr/bin/systemctl", "reboot").Run(); err != nil {
			log.Printf("[Reboot] Failed: %v", err)
		}
	}()

	return map[string]interface{}{
		"success":      true,
		"reboot_in_sec": 2,
		"message":      "Reboot scheduled. Machine will restart in 2 seconds.",
	}, nil
}
