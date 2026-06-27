package actions

import "testing"

func TestValidateDownloadURL(t *testing.T) {
	PinnedServerURL = "wss://nexus.example.com/ws/agent"
	bad := []string{
		"http://nexus.example.com/api/agents/download",        // pas https
		"https://attacker.example/api/agents/download",        // hôte non pinné
		"https://nexus.example.com/etc/passwd",                // chemin non autorisé
		"https://169.254.169.254/api/agents/download",         // SSRF metadata
		"://bad",                                              // invalide
	}
	for _, u := range bad {
		if err := validateDownloadURL(u); err == nil {
			t.Errorf("download_url malveillant accepté: %s", u)
		}
	}
	if err := validateDownloadURL("https://nexus.example.com/api/agents/download"); err != nil {
		t.Errorf("download_url légitime rejeté: %v", err)
	}
	// Insensible à la casse de l'hôte.
	if err := validateDownloadURL("https://Nexus.Example.COM/api/agents/download"); err != nil {
		t.Errorf("hôte casse différente rejeté: %v", err)
	}
}
