package actions

import "testing"

func TestValidateDownloadURL(t *testing.T) {
	PinnedServerURL = "wss://nexus.example.com/ws/agent"
	bad := []string{
		"http://nexus.example.com/api/agents/download", // not https
		"https://attacker.example/api/agents/download", // unpinned host
		"https://nexus.example.com/etc/passwd",         // disallowed path
		"https://169.254.169.254/api/agents/download",  // SSRF metadata
		"://bad", // invalid
	}
	for _, u := range bad {
		if err := validateDownloadURL(u); err == nil {
			t.Errorf("malicious download_url accepted: %s", u)
		}
	}
	if err := validateDownloadURL("https://nexus.example.com/api/agents/download"); err != nil {
		t.Errorf("legitimate download_url rejected: %v", err)
	}
	// Case-insensitive on the host.
	if err := validateDownloadURL("https://Nexus.Example.COM/api/agents/download"); err != nil {
		t.Errorf("different-case host rejected: %v", err)
	}
}
