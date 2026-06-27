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
// ssl.scan : trouve les certs dans les emplacements standards
// (/etc/letsencrypt/live/*, /etc/ssl/certs, nginx/apache confs)
// et retourne leurs dates d'expiration.
// ═══════════════════════════════════════════════════════════════

type SslScanAction struct{}

func (a *SslScanAction) ID() string                                 { return "ssl.scan" }
func (a *SslScanAction) Capability() string                         { return "monitoring" }
func (a *SslScanAction) Validate(_ map[string]interface{}) error    { return nil }

// Emplacements scannes par defaut — CERTIFICATS PUBLICS uniquement.
// /etc/ssl/private (répertoire de clés privées par définition) est volontairement
// EXCLU : ssl.scan ne parse que des certificats, et le lister via sudo find serait
// la sur-lecture que NEXUS-AGENT-001/002 ferment.
//
// IMPORTANT (NEXUS-AGENT-001) : cette liste est FIGÉE et passée TELLE QUELLE à
// `sudo find` (pas de filtrage par existence), pour matcher byte-identiquement la
// ligne sudoers à prédicat épinglé. find tolère une racine absente (il liste les
// autres). Toute modif ici doit être répercutée dans scripts/install-agent.sh.
var sslScanPaths = []string{
	"/etc/letsencrypt/live",
	"/etc/ssl/certs/ssl-cert-snakeoil.pem", // souvent present
	"/etc/nginx/ssl",
	"/etc/apache2/ssl",
	"/etc/haproxy/certs",
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
	expiringSoon := []CertInfo{} // non-nil → JSON [] et pas null (anti-crash front)
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

// listCandidateCertFiles utilise sudo find pour lister les fichiers .pem/.crt
// dans les emplacements courants. Retourne une liste deduplique.
func listCandidateCertFiles() []string {
	seen := map[string]bool{}
	// NEXUS-AGENT-001 — prédicat ÉPINGLÉ, byte-identique à la ligne sudoers :
	// racines FIGÉES (pas de filtrage), -maxdepth/-type/-name, AUCUNE queue ouverte
	// (pas de ` *` final), PAS de parens (pour rester parsable par sudoers). Le `*`
	// précédence : `(-type f -name *.pem) OR (-type f -name *.crt)`, -maxdepth est
	// une option globale. → impossible d'appender -exec/-fprintf/-execdir.
	args := []string{"-n", "/usr/bin/find"}
	args = append(args, sslScanPaths...)
	args = append(args, "-maxdepth", "4", "-type", "f", "-name", "*.pem", "-o", "-type", "f", "-name", "*.crt")
	cmd := exec.Command("sudo", args...)
	cmd.Stderr = io.Discard // une racine absente fait sortir find ≠ 0 + un message ; on l'ignore
	// find liste les racines existantes sur stdout même si une autre manque (exit ≠ 0).
	out, _ := cmd.Output()
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
