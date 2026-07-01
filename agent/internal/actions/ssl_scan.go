package actions

import (
	"bytes"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"
)

func init() {
	Register(&SslScanAction{})
}

// ═══════════════════════════════════════════════════════════════
// ssl.scan: finds certs in the standard locations
// (/etc/letsencrypt/live/*, /etc/ssl/certs, nginx/apache confs)
// and returns their expiration dates.
// ═══════════════════════════════════════════════════════════════

type SslScanAction struct{}

func (a *SslScanAction) ID() string                              { return "ssl.scan" }
func (a *SslScanAction) Capability() string                      { return "monitoring" }
func (a *SslScanAction) Validate(_ map[string]interface{}) error { return nil }

// Locations scanned by default — PUBLIC CERTIFICATES only.
// /etc/ssl/private (a private-key directory by definition) is deliberately
// EXCLUDED: ssl.scan only parses certificates, and listing it via sudo find would
// be the over-read that NEXUS-AGENT-001/002 close off.
//
// IMPORTANT (NEXUS-AGENT-001): this list is FIXED and passed AS-IS to
// `sudo find` (no filtering by existence), to match byte-identically the
// sudoers line with pinned predicate. find tolerates an absent root (it lists the
// others). Any change here must be mirrored in scripts/install-agent.sh.
var sslScanPaths = []string{
	"/etc/letsencrypt/live",
	"/etc/ssl/certs/ssl-cert-snakeoil.pem", // often present
	"/etc/nginx/ssl",
	"/etc/apache2/ssl",
	"/etc/haproxy/certs",
}

type CertInfo struct {
	Path          string    `json:"path"`
	Subject       string    `json:"subject"`
	Issuer        string    `json:"issuer"`
	DNSNames      []string  `json:"dns_names"`
	NotBefore     time.Time `json:"not_before"`
	NotAfter      time.Time `json:"not_after"`
	DaysRemaining int       `json:"days_remaining"`
	IsSelfSigned  bool      `json:"is_self_signed"`
	IsCA          bool      `json:"is_ca"`
}

func (a *SslScanAction) Execute(_ map[string]interface{}) (interface{}, error) {
	certs := []CertInfo{}
	seen := map[string]bool{}

	// List all candidate files via sudo find (bypasses root:root 700 perms)
	files := listCandidateCertFiles()

	for _, path := range files {
		if seen[path] {
			continue
		}
		if c, err := parseCertFile(path); err == nil && c != nil {
			certs = append(certs, *c)
			seen[path] = true
		}
	}

	// Filter out CAs and self-signed snake-oil (noise)
	filtered := make([]CertInfo, 0, len(certs))
	for _, c := range certs {
		if c.IsCA {
			continue
		}
		if strings.Contains(strings.ToLower(c.Subject), "snakeoil") {
			continue
		}
		filtered = append(filtered, c)
	}

	// Find the cert closest to expiration
	var minDays = 9999
	expiringSoon := []CertInfo{} // non-nil → JSON [] and not null (anti-crash front)
	for _, c := range filtered {
		if c.DaysRemaining < minDays {
			minDays = c.DaysRemaining
		}
		if c.DaysRemaining <= 30 {
			expiringSoon = append(expiringSoon, c)
		}
	}

	return map[string]interface{}{
		"certs":         filtered,
		"count":         len(filtered),
		"min_days":      minDays,
		"expiring_soon": expiringSoon,
	}, nil
}

// listCandidateCertFiles uses sudo find to list .pem/.crt files in the common
// locations. Returns a deduplicated list.
func listCandidateCertFiles() []string {
	seen := map[string]bool{}
	// NEXUS-AGENT-001 — PINNED predicate, byte-identical to the sudoers line:
	// FIXED roots (no filtering), -maxdepth/-type/-name, NO open tail
	// (no trailing ` *`), NO parens (to stay parseable by sudoers). The `*`
	// precedence: `(-type f -name *.pem) OR (-type f -name *.crt)`, -maxdepth is
	// a global option. → impossible to append -exec/-fprintf/-execdir.
	args := []string{"-n", "/usr/bin/find"}
	args = append(args, sslScanPaths...)
	args = append(args, "-maxdepth", "4", "-type", "f", "-name", "*.pem", "-o", "-type", "f", "-name", "*.crt")
	cmd := exec.Command("sudo", args...)
	cmd.Stderr = io.Discard // an absent root makes find exit ≠ 0 + a message; we ignore it
	// find lists the existing roots on stdout even if another is missing (exit ≠ 0).
	out, _ := cmd.Output()
	paths := []string{}
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || seen[line] {
			continue
		}
		// Exclude system CAs (ca-certificates.crt etc)
		if strings.Contains(line, "/etc/ssl/certs/ca-") {
			continue
		}
		seen[line] = true
		paths = append(paths, line)
	}
	return paths
}

func parseCertFile(path string) (*CertInfo, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		// Try via sudo cat (for /etc/letsencrypt/live which is root:root 700)
		if cmd := exec.Command("sudo", "-n", "/bin/cat", path); cmd != nil {
			if out, err2 := cmd.Output(); err2 == nil {
				data = out
			} else {
				return nil, err
			}
		}
	}
	// A file may contain several certificates (fullchain). We take the first
	// one that is not a CA (that's the leaf).
	rest := data
	var leaf *x509.Certificate
	for {
		var block *pem.Block
		block, rest = pem.Decode(rest)
		if block == nil {
			break
		}
		if block.Type != "CERTIFICATE" {
			continue
		}
		cert, err := x509.ParseCertificate(block.Bytes)
		if err != nil {
			continue
		}
		if !cert.IsCA {
			leaf = cert
			break
		}
		// If we don't have a leaf yet, keep this one as a fallback
		if leaf == nil {
			leaf = cert
		}
	}
	if leaf == nil {
		return nil, fmt.Errorf("no certificate found in %s", path)
	}

	now := time.Now()
	days := int(leaf.NotAfter.Sub(now).Hours() / 24)
	selfSigned := bytes.Equal(leaf.RawIssuer, leaf.RawSubject)

	return &CertInfo{
		Path:          path,
		Subject:       leaf.Subject.CommonName,
		Issuer:        leaf.Issuer.CommonName,
		DNSNames:      leaf.DNSNames,
		NotBefore:     leaf.NotBefore,
		NotAfter:      leaf.NotAfter,
		DaysRemaining: days,
		IsSelfSigned:  selfSigned,
		IsCA:          leaf.IsCA,
	}, nil
}
