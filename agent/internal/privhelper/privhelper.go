// Package privhelper is the agent's COMPILED root wrapper (no shell/interpreter
// invocable). Invoked via `sudo /usr/local/bin/nexus-agent privhelper <op>
// <args>`, it runs as root and executes STRICTLY validated privileged
// operations (user creation, config writes), in place of the old exploitable
// sudoers lines `useradd *` / `install … */…*`.
//
// NEXUS-AGENT-003/008. Properties: binary root:root 0755 (the non-root agent can
// neither modify it nor invoke an interpreter within it); validated arguments
// (login regex, realpath BEFORE use, literal dest); no arg is executed as a
// command.
package privhelper

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

// Prod paths (var, not const, for test injection). stagingDir = the agent's
// state directory (nexus-agent:nexus-agent 0700); any write source must resolve
// STRICTLY under it (separator included).
var (
	stagingDir = "/var/lib/nexus-agent"
	netplanDir = "/etc/netplan"
	sshdDropin = "/etc/ssh/sshd_config.d/99-nexus-hardening.conf" // FIXED dest

	loginRe       = regexp.MustCompile(`^[a-z_][a-z0-9_-]{0,31}$`) // POSIX login
	netplanNameRe = regexp.MustCompile(`^[A-Za-z0-9._-]+\.yaml$`)  // safe netplan filename

	// NEXUS-AGENT-006 — service control via compiled wrapper. The verb is
	// enumerated and the unit is a SINGLE token with no leading dash: no option
	// (`--no-ask-password`, `-f`, …) can be injected between the verb and the
	// unit (the bug that bypassed the sudoers blocklist `systemctl stop ssh*`).
	svcVerbRe = regexp.MustCompile(`^(start|stop|restart|reload|enable|disable)$`)
	svcUnitRe = regexp.MustCompile(`^[a-zA-Z0-9@_.][a-zA-Z0-9@_.\-]{0,127}$`)

	// NEXUS-AGENT-010 — package install/remove via the compiled wrapper. The verb
	// is enumerated and each name is a package token with NO leading dash: only a
	// package name can ever follow the fixed verb, so the apt/dnf/yum option-
	// injection vectors (`-o APT::…::Pre-Invoke=`, `-c <config>`, `changelog`)
	// are structurally impossible. Replaces the `apt-get install *` sudoers
	// wildcard (whose NOEXEC backstop broke apt's own method/dpkg exec).
	pkgVerbRe = regexp.MustCompile(`^(install|remove)$`)
	pkgNameRe = regexp.MustCompile(`^[a-z0-9][a-z0-9+.\-]*$`)
)

// Units the agent must NEVER stop/disrupt, even if the Go layer is bypassed
// (attacker with a nexus-agent shell): ssh/sshd (admin lock-out) and
// nexus-agent itself (self-DoS, consistent with the AGENT-004 self-guard).
// Blocked for destructive verbs only.
var svcProtectedUnits = map[string]bool{
	"ssh":         true,
	"sshd":        true,
	"nexus-agent": true,
}

// Run dispatches the privhelper subcommand. args = os.Args[2:].
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
	case "svc":
		return doSvc(rest)
	case "pkg":
		return doPkg(rest)
	default:
		return fail("privhelper: unknown operation " + op)
	}
}

// resolveUnderStaging does the realpath (resolving `..` AND symlinks) BEFORE
// any use of the path, then requires the result to be STRICTLY under
// stagingDir + separator. The comparison uses "/var/lib/nexus-agent/" WITH the
// slash → a path like /var/lib/nexus-agent-evil/x is REFUSED (the trap of a
// prefix without a separator). Also requires a regular file.
func resolveUnderStaging(src string) (string, error) {
	real, err := filepath.EvalSymlinks(src) // realpath BEFORE use
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

// validNetplanDst: the destination must be a *.yaml file DIRECTLY under
// /etc/netplan, without traversal. filepath.Clean resolves `..`; we check that
// the RESOLVED parent directory (symlinks) is exactly /etc/netplan, and the
// base name via netplanNameRe (forbids `/`). Returns the canonical path.
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
	// `--` ends option parsing → `-o -u 0` IMPOSSIBLE; login validated.
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
	// FIXED destination (Nexus drop-in) — realpath-validated source (closes the
	// source wildcard of the old sudoers line).
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

// homeOf resolves the user's home via getent passwd (never a glob /home/*:
// a validated user may have a home outside /home, e.g. root → /root).
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

// doSvc — NEXUS-AGENT-006. Canonicalized systemd service control: enumerated
// verb + validated unit (one token, no leading dash), executed as FIXED
// POSITIONAL arguments `systemctl <verb> <unit>`. No option can slip in (closes
// the bypass `systemctl stop --no-ask-password ssh`). Destructive verbs on
// ssh/sshd/nexus-agent are refused in code.
func doSvc(args []string) int {
	if len(args) != 2 {
		return fail("usage: privhelper svc <verb> <unit>")
	}
	verb, unit := args[0], args[1]
	if !svcVerbRe.MatchString(verb) {
		return fail("svc: invalid verb")
	}
	if !svcUnitRe.MatchString(unit) {
		return fail("svc: invalid unit name")
	}
	// base = name without the .service suffix for comparison to protected units.
	base := strings.TrimSuffix(unit, ".service")
	if verb == "stop" || verb == "restart" || verb == "reload" || verb == "disable" {
		if svcProtectedUnits[base] {
			return fail("svc: refusing " + verb + " on protected unit " + unit)
		}
	}
	return run("/usr/bin/systemctl", verb, unit)
}

// doPkg installs/removes distro packages as root. Names are validated (no
// leading dash → no option injection), the argv is FIXED, and the manager is
// exec'd directly (no NOEXEC) so it can spawn its download methods + dpkg/rpm.
func doPkg(args []string) int {
	if len(args) < 2 {
		return fail("usage: privhelper pkg <install|remove> <name>...")
	}
	verb, names := args[0], args[1:]
	if !pkgVerbRe.MatchString(verb) {
		return fail("pkg: invalid verb")
	}
	for _, n := range names {
		if !pkgNameRe.MatchString(n) {
			return fail("pkg: invalid package name: " + n)
		}
	}
	// Fixed paths (no PATH lookup); first available manager wins.
	var argv, env []string
	switch {
	case fileExecutable("/usr/bin/apt-get"):
		argv = append([]string{"/usr/bin/apt-get", verb, "-y", "-qq"}, names...)
		env = append(os.Environ(), "DEBIAN_FRONTEND=noninteractive")
	case fileExecutable("/usr/bin/dnf"):
		argv = append([]string{"/usr/bin/dnf", verb, "-y", "-q"}, names...)
	case fileExecutable("/usr/bin/yum"):
		argv = append([]string{"/usr/bin/yum", verb, "-y", "-q"}, names...)
	default:
		return fail("pkg: no supported package manager (apt-get/dnf/yum)")
	}
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	if env != nil {
		cmd.Env = env
	}
	if err := cmd.Run(); err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			return ee.ExitCode()
		}
		fmt.Fprintf(os.Stderr, "privhelper: %v\n", err)
		return 1
	}
	return 0
}

func fileExecutable(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && !fi.IsDir() && fi.Mode()&0111 != 0
}

func fail(msg string) int {
	fmt.Fprintln(os.Stderr, msg)
	return 2
}
