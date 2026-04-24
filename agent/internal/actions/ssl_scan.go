package actions

import (
	"bytes"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

func init() {
	Register(&SslScanAction{})
}

// ═══════════════════════════════════════════════════════════════
// ssl.scan : trouve les certs dans les emplacements standards
// (/etc/letsencrypt/live/*, /etc/ssl/certs, nginx/apache confs)
// et retourne leurs dates d'expiration.
// ═══════════════════════════════════════════════════════════════

type SslScanAction struct{}

func (a *SslScanAction) ID() string                                 { return "ssl.scan" }
func (a *SslScanAction) Capability() string                         { return "monitoring" }
func (a *SslScanAction) Validate(_ map[string]interface{}) error    { return nil }

// Emplacements scannes par defaut.
var sslScanPaths = []string{
	"/etc/letsencrypt/live",
	"/etc/ssl/private",
	"/etc/ssl/certs/ssl-cert-snakeoil.pem", // souvent present
	"/etc/nginx/ssl",
	"/etc/apache2/ssl",
	"/etc/haproxy/certs",
}

// Patterns de fichiers a considerer
var sslFilePatterns = []string{
	"fullchain.pem",
	"cert.pem",
	"*.crt",
	"*.pem",
}

type CertInfo struct {
	Path           string    `json:"path"`
	Subject        string    `json:"subject"`
	Issuer         string    `json:"issuer"`
	DNSNames       []string  `json:"dns_names"`
	NotBefore      time.Time `json:"not_before"`
	NotAfter       time.Time `json:"not_after"`
	DaysRemaining  int       `json:"days_remaining"`
	IsSelfSigned   bool      `json:"is_self_signed"`
	IsCA           bool      `json:"is_ca"`
}

func (a *SslScanAction) Execute(_ map[string]interface{}) (interface{}, error) {
	certs := []CertInfo{}
	seen := map[string]bool{}

	// Lister tous les fichiers candidats via sudo find (contourne les perms root:root 700)
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

	// Filtrer les CA et self-signed snake-oil (bruit)
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

	// Trouver le cert le plus proche de l'expiration
	var minDays = 9999
	var expiringSoon []CertInfo
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

func matchesAnyPattern(name string, patterns []string) bool {
	for _, p := range patterns {
		if matched, _ := filepath.Match(p, name); matched {
			return true
		}
	}
	return false
}

// listCandidateCertFiles utilise sudo find pour lister les fichiers .pem/.crt
// dans les emplacements courants. Retourne une liste deduplique.
func listCandidateCertFiles() []string {
	seen := map[string]bool{}
	// find avec -name pour chaque pattern, limite depth a 4
	args := []string{"-n", "/usr/bin/find"}
	// Filtrer les paths qui existent
	for _, root := range sslScanPaths {
		if _, err := os.Stat(root); err == nil {
			args = append(args, root)
		}
	}
	if len(args) == 2 {
		return nil
	}
	args = append(args, "-maxdepth", "4", "-type", "f",
		"(", "-name", "fullchain.pem",
		"-o", "-name", "cert.pem",
		"-o", "-name", "*.crt",
		"-o", "-name", "*.pem",
		")")
	cmd := exec.Command("sudo", args...)
	out, err := cmd.Output()
	if err != nil {
		return nil
	}
	paths := []string{}
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || seen[line] {
			continue
		}
		// Exclure les CAs systeme (ca-certificates.crt etc)
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
		// Essayer via sudo cat (pour /etc/letsencrypt/live qui est root:root 700)
		if cmd := exec.Command("sudo", "-n", "/bin/cat", path); cmd != nil {
			if out, err2 := cmd.Output(); err2 == nil {
				data = out
			} else {
				return nil, err
			}
		}
	}
	// Un fichier peut contenir plusieurs certificats (fullchain). On prend
	// le premier qui n'est pas un CA (c'est le leaf).
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
		// Si on n'a pas encore de leaf, garder celui-ci comme fallback
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
