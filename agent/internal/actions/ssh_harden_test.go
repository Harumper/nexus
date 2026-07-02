package actions

import (
	"os"
	"strings"
	"testing"
)

func TestSshdHardeningDropinStructure(t *testing.T) {
	d := sshdHardeningDropin()
	for _, want := range []string{
		"KexAlgorithms ", "curve25519-sha256", "diffie-hellman-group16-sha512",
		"Ciphers chacha20-poly1305@openssh.com", "MACs hmac-sha2-512-etm@openssh.com",
		"MaxAuthTries 4", "X11Forwarding no",
		"PermitEmptyPasswords no", "IgnoreRhosts yes", "HostbasedAuthentication no",
		"PermitUserEnvironment no", "ClientAliveInterval 300", "ClientAliveCountMax 2",
		"LogLevel VERBOSE",
	} {
		if !strings.Contains(d, want) {
			t.Errorf("drop-in missing %q", want)
		}
	}
	// Must NOT SET the lock-out-risky directives. They legitimately appear in the
	// header comment ("deliberately NOT modified"), so only flag actual directive
	// lines (a non-comment line starting with the keyword).
	for _, line := range strings.Split(d, "\n") {
		trimmed := strings.TrimSpace(line)
		for _, forbidden := range []string{"PasswordAuthentication", "PermitRootLogin"} {
			if strings.HasPrefix(trimmed, forbidden+" ") {
				t.Errorf("drop-in must not set %q (lock-out risk): %q", forbidden, line)
			}
		}
	}
	// Post-quantum KEX must appear IFF the local OpenSSH advertises it (version
	// detection) — otherwise sshd -t would reject an unknown algorithm.
	sup := supportedKexAlgorithms()
	for _, pq := range pqKexCandidates {
		if got := strings.Contains(d, pq); got != sup[pq] {
			t.Errorf("PQ %q: supported=%v but present-in-dropin=%v", pq, sup[pq], got)
		}
	}
	// Integration hook: dump the exact generated drop-in so a real `sshd -t` can
	// validate it (see the container check in CI/manual runs).
	if p := os.Getenv("NEXUS_DROPIN_DUMP"); p != "" {
		if err := os.WriteFile(p, []byte(d), 0644); err != nil {
			t.Fatalf("dump drop-in: %v", err)
		}
	}
}

func TestKexAlgorithmsLineEndsWithBase(t *testing.T) {
	line := kexAlgorithmsLine()
	if !strings.HasSuffix(line, baseKexAlgorithms) {
		t.Errorf("kexAlgorithmsLine %q must end with the classical base list", line)
	}
	if strings.Contains(line, ",,") || strings.HasPrefix(line, ",") {
		t.Errorf("malformed KexAlgorithms line: %q", line)
	}
}
