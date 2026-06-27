// Package privhelper est le wrapper root COMPILÉ de l'agent (aucun shell/
// interpréteur invocable). Invoqué via `sudo /usr/local/bin/nexus-agent privhelper
// <op> <args>`, il tourne en root et exécute des opérations privilégiées
// STRICTEMENT validées (création d'utilisateur, écritures de config), à la place
// des anciennes lignes sudoers `useradd *` / `install … */…*` exploitables.
//
// NEXUS-AGENT-003/008. Propriétés : binaire root:root 0755 (l'agent non-root ne
// peut ni modifier ni invoquer un interpréteur dedans) ; arguments validés
// (regex login, realpath AVANT usage, dest littérale) ; aucun arg n'est exécuté
// comme commande.
package privhelper

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

// Chemins de prod (var, pas const, pour injection en test). stagingDir =
// répertoire d'état de l'agent (nexus-agent:nexus-agent 0700) ; toute source
// d'écriture doit y résoudre STRICTEMENT (séparateur inclus).
var (
	stagingDir = "/var/lib/nexus-agent"
	netplanDir = "/etc/netplan"
	sshdDropin = "/etc/ssh/sshd_config.d/99-nexus-hardening.conf" // dest FIXE

	loginRe       = regexp.MustCompile(`^[a-z_][a-z0-9_-]{0,31}$`) // POSIX login
	netplanNameRe = regexp.MustCompile(`^[A-Za-z0-9._-]+\.yaml$`)  // nom de fichier netplan sûr
)

// Run dispatche la sous-commande privhelper. args = os.Args[2:].
func Run(args []string) int {
	if len(args) == 0 {
		return fail("privhelper: missing operation")
	}
	op, rest := args[0], args[1:]
	switch op {
	case "useradd":
		return doUseradd(rest)
	case "install-netplan":
		return doInstallNetplan(rest)
	case "install-sshd":
		return doInstallSshd(rest)
	case "install-authkeys":
		return doInstallAuthkeys(rest)
	default:
		return fail("privhelper: unknown operation " + op)
	}
}

// resolveUnderStaging fait le realpath (résolution de `..` ET des symlinks) AVANT
// toute utilisation du chemin, puis exige que le résultat soit STRICTEMENT sous
// stagingDir + séparateur. La comparaison utilise "/var/lib/nexus-agent/" AVEC le
// slash → un chemin comme /var/lib/nexus-agent-evil/x est REFUSÉ (le piège du
// préfixe sans séparateur). Exige aussi un fichier régulier.
func resolveUnderStaging(src string) (string, error) {
	real, err := filepath.EvalSymlinks(src) // realpath AVANT usage
	if err != nil {
		return "", fmt.Errorf("resolve source: %w", err)
	}
	base := stagingDir + string(os.PathSeparator) // "/var/lib/nexus-agent/"
	if !strings.HasPrefix(real, base) {
		return "", fmt.Errorf("source must be strictly under %s", base)
	}
	fi, err := os.Lstat(real)
	if err != nil || !fi.Mode().IsRegular() {
		return "", fmt.Errorf("source must be a regular file")
	}
	return real, nil
}

// validNetplanDst : la destination doit être un fichier *.yaml DIRECTEMENT sous
// /etc/netplan, sans traversal. filepath.Clean résout `..` ; on vérifie que le
// répertoire parent RÉSOLU (symlinks) est exactement /etc/netplan, et le nom de
// base via netplanNameRe (interdit `/`). Retourne le chemin canonique.
func validNetplanDst(dst string) (string, error) {
	clean := filepath.Clean(dst)
	parent, err := filepath.EvalSymlinks(filepath.Dir(clean))
	if err != nil {
		return "", fmt.Errorf("resolve netplan dir: %w", err)
	}
	if parent != netplanDir {
		return "", fmt.Errorf("destination not directly under %s", netplanDir)
	}
	base := filepath.Base(clean)
	if !netplanNameRe.MatchString(base) {
		return "", fmt.Errorf("unsafe netplan filename: %s", base)
	}
	return filepath.Join(netplanDir, base), nil
}

func doUseradd(args []string) int {
	if len(args) < 1 || len(args) > 2 {
		return fail("usage: privhelper useradd <login> [gecos]")
	}
	login := args[0]
	if !loginRe.MatchString(login) {
		return fail("invalid login name")
	}
	gecos := ""
	if len(args) == 2 {
		gecos = args[1]
		if strings.ContainsAny(gecos, ":\n\r") {
			return fail("invalid gecos")
		}
	}
	// `--` termine le parsing d'options → `-o -u 0` IMPOSSIBLE ; login validé.
	return run("/usr/sbin/useradd", "-m", "-s", "/bin/bash", "-c", gecos, "--", login)
}

func doInstallNetplan(args []string) int {
	if len(args) != 2 {
		return fail("usage: privhelper install-netplan <src> <dst>")
	}
	src, err := resolveUnderStaging(args[0])
	if err != nil {
		return fail(err.Error())
	}
	dst, err := validNetplanDst(args[1])
	if err != nil {
		return fail(err.Error())
	}
	return run("/usr/bin/install", "-m", "600", "-o", "root", "-g", "root", src, dst)
}

func doInstallSshd(args []string) int {
	if len(args) != 1 {
		return fail("usage: privhelper install-sshd <src>")
	}
	src, err := resolveUnderStaging(args[0])
	if err != nil {
		return fail(err.Error())
	}
	// Destination FIXE (drop-in Nexus) — source realpath-validée (ferme le wildcard
	// source de l'ancienne ligne sudoers).
	return run("/usr/bin/install", "-m", "644", "-o", "root", "-g", "root", src, sshdDropin)
}

func doInstallAuthkeys(args []string) int {
	if len(args) != 2 {
		return fail("usage: privhelper install-authkeys <login> <src>")
	}
	login := args[0]
	if !loginRe.MatchString(login) {
		return fail("invalid login name")
	}
	home, err := homeOf(login)
	if err != nil {
		return fail(err.Error())
	}
	src, err := resolveUnderStaging(args[1])
	if err != nil {
		return fail(err.Error())
	}
	sshDir := filepath.Join(home, ".ssh")
	authFile := filepath.Join(sshDir, "authorized_keys")
	if rc := run("/usr/bin/install", "-d", "-m", "700", "-o", login, "-g", login, sshDir); rc != 0 {
		return rc
	}
	return run("/usr/bin/install", "-m", "600", "-o", login, "-g", login, src, authFile)
}

// homeOf résout le home de l'utilisateur via getent passwd (jamais un glob
// /home/* : un utilisateur validé peut avoir un home hors /home, ex. root → /root).
func homeOf(login string) (string, error) {
	out, err := exec.Command("/usr/bin/getent", "passwd", login).Output()
	if err != nil {
		return "", fmt.Errorf("unknown user %q", login)
	}
	fields := strings.Split(strings.TrimSpace(string(out)), ":")
	if len(fields) < 6 || fields[5] == "" {
		return "", fmt.Errorf("no home for %q", login)
	}
	home := fields[5]
	if !filepath.IsAbs(home) {
		return "", fmt.Errorf("non-absolute home for %q", login)
	}
	return home, nil
}

func run(name string, args ...string) int {
	cmd := exec.Command(name, args...)
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			return ee.ExitCode()
		}
		fmt.Fprintf(os.Stderr, "privhelper: %v\n", err)
		return 1
	}
	return 0
}

func fail(msg string) int {
	fmt.Fprintln(os.Stderr, msg)
	return 2
}
