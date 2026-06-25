package actions

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

func init() {
	Register(&UserListAction{})
	Register(&UserCreateAction{})
	Register(&UserDeleteAction{})
	Register(&UserUpdateSudoAction{})
	Register(&SshKeyListAction{})
	Register(&SshKeyAddAction{})
	Register(&SshKeyRemoveAction{})
}

// Regex de validation UNIX login name (POSIX) : 1-32 chars, pas de -, ., @ en debut
var userNameRegex = regexp.MustCompile(`^[a-z_][a-z0-9_-]{0,31}$`)

// Minimum UID pour les users humains (non systeme)
const minHumanUID = 1000

// Users proteges (jamais toucher)
var protectedUsers = map[string]bool{
	"root":        true,
	"nexus-agent": true,
}

// ═══════════════════════════════════════════════════════════════
// user.list : parse /etc/passwd en filtrant UID >= 1000
// ═══════════════════════════════════════════════════════════════

type LinuxUser struct {
	Username string `json:"username"`
	UID      int    `json:"uid"`
	GID      int    `json:"gid"`
	Gecos    string `json:"gecos"`
	Home     string `json:"home"`
	Shell    string `json:"shell"`
	Sudo     bool   `json:"sudo"`
	Groups   []string `json:"groups"`
}

type UserListAction struct{}

func (a *UserListAction) ID() string                                 { return "user.list" }
func (a *UserListAction) Capability() string                         { return "monitoring" }
func (a *UserListAction) Validate(_ map[string]interface{}) error    { return nil }

func (a *UserListAction) Execute(_ map[string]interface{}) (interface{}, error) {
	f, err := os.Open("/etc/passwd")
	if err != nil {
		return nil, fmt.Errorf("read /etc/passwd: %w", err)
	}
	defer f.Close()

	// Lire les membres du groupe sudo une fois
	sudoMembers := sudoGroupMembers()

	users := []LinuxUser{}
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		parts := strings.Split(line, ":")
		if len(parts) < 7 {
			continue
		}
		uid, _ := strconv.Atoi(parts[2])
		gid, _ := strconv.Atoi(parts[3])
		// On filtre : uid>=1000 OU root (utile de l'afficher en lecture seule)
		if uid < minHumanUID && uid != 0 {
			continue
		}
		username := parts[0]
		groups := userGroups(username)
		users = append(users, LinuxUser{
			Username: username,
			UID:      uid,
			GID:      gid,
			Gecos:    parts[4],
			Home:     parts[5],
			Shell:    parts[6],
			Sudo:     sudoMembers[username] || username == "root",
			Groups:   groups,
		})
	}

	return map[string]interface{}{
		"users": users,
		"count": len(users),
	}, nil
}

func sudoGroupMembers() map[string]bool {
	members := map[string]bool{}
	for _, grp := range []string{"sudo", "wheel", "admin"} {
		g, err := user.LookupGroup(grp)
		if err != nil {
			continue
		}
		// Parser /etc/group directement
		f, err := os.Open("/etc/group")
		if err != nil {
			continue
		}
		scanner := bufio.NewScanner(f)
		for scanner.Scan() {
			line := scanner.Text()
			parts := strings.Split(line, ":")
			if len(parts) >= 4 && parts[0] == g.Name {
				for _, m := range strings.Split(parts[3], ",") {
					if m != "" {
						members[m] = true
					}
				}
			}
		}
		f.Close()
	}
	return members
}

func userGroups(username string) []string {
	u, err := user.Lookup(username)
	if err != nil {
		return nil
	}
	gids, err := u.GroupIds()
	if err != nil {
		return nil
	}
	names := []string{} // non-nil → JSON [] et pas null
	for _, gid := range gids {
		g, err := user.LookupGroupId(gid)
		if err == nil {
			names = append(names, g.Name)
		}
	}
	return names
}

// ═══════════════════════════════════════════════════════════════
// user.create : useradd -m -s /bin/bash <name>
// ═══════════════════════════════════════════════════════════════

type UserCreateAction struct{}

func (a *UserCreateAction) ID() string         { return "user.create" }
func (a *UserCreateAction) Capability() string { return "system_control" }

func (a *UserCreateAction) Validate(params map[string]interface{}) error {
	return validateUserName(params)
}

func (a *UserCreateAction) Execute(params map[string]interface{}) (interface{}, error) {
	username := params["username"].(string)
	args := []string{"-n", "/usr/sbin/useradd", "-m", "-s", "/bin/bash"}

	if g, ok := params["gecos"].(string); ok && g != "" {
		if len(g) > 128 || strings.ContainsAny(g, ":\n") {
			return nil, fmt.Errorf("invalid gecos")
		}
		args = append(args, "-c", g)
	}
	args = append(args, username)

	cmd := exec.Command("sudo", args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("useradd failed: %s", strings.TrimSpace(string(out)))
	}

	// Ajouter au groupe sudo si demande
	if sudo, _ := params["sudo"].(bool); sudo {
		if err := setSudoMembership(username, true); err != nil {
			return nil, fmt.Errorf("user created but failed to add to sudo: %w", err)
		}
	}

	return map[string]interface{}{
		"username": username,
		"created":  true,
	}, nil
}

// ═══════════════════════════════════════════════════════════════
// user.delete : userdel -r <name>
// ═══════════════════════════════════════════════════════════════

type UserDeleteAction struct{}

func (a *UserDeleteAction) ID() string         { return "user.delete" }
func (a *UserDeleteAction) Capability() string { return "system_control" }

func (a *UserDeleteAction) Validate(params map[string]interface{}) error {
	if err := validateUserName(params); err != nil {
		return err
	}
	username := params["username"].(string)
	if protectedUsers[username] {
		return fmt.Errorf("refusing to delete protected user %s", username)
	}
	// Verifier UID >= 1000
	u, err := user.Lookup(username)
	if err != nil {
		return fmt.Errorf("user %s not found", username)
	}
	uid, _ := strconv.Atoi(u.Uid)
	if uid < minHumanUID {
		return fmt.Errorf("refusing to delete system user (uid=%d)", uid)
	}
	return nil
}

func (a *UserDeleteAction) Execute(params map[string]interface{}) (interface{}, error) {
	username := params["username"].(string)
	cmd := exec.Command("sudo", "-n", "/usr/sbin/userdel", "-r", username)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("userdel failed: %s", strings.TrimSpace(string(out)))
	}
	return map[string]interface{}{
		"username": username,
		"deleted":  true,
	}, nil
}

// ═══════════════════════════════════════════════════════════════
// user.update_sudo : gpasswd -a/-d sudo <name>
// ═══════════════════════════════════════════════════════════════

type UserUpdateSudoAction struct{}

func (a *UserUpdateSudoAction) ID() string         { return "user.update_sudo" }
func (a *UserUpdateSudoAction) Capability() string { return "system_control" }

func (a *UserUpdateSudoAction) Validate(params map[string]interface{}) error {
	if err := validateUserName(params); err != nil {
		return err
	}
	username := params["username"].(string)
	if protectedUsers[username] {
		return fmt.Errorf("refusing to modify protected user %s", username)
	}
	if _, ok := params["sudo"].(bool); !ok {
		return fmt.Errorf("parameter 'sudo' must be a boolean")
	}
	return nil
}

func (a *UserUpdateSudoAction) Execute(params map[string]interface{}) (interface{}, error) {
	username := params["username"].(string)
	sudo := params["sudo"].(bool)
	if err := setSudoMembership(username, sudo); err != nil {
		return nil, err
	}
	return map[string]interface{}{
		"username": username,
		"sudo":     sudo,
	}, nil
}

func setSudoMembership(username string, sudo bool) error {
	verb := "-a"
	if !sudo {
		verb = "-d"
	}
	cmd := exec.Command("sudo", "-n", "/usr/sbin/gpasswd", verb, username, "sudo")
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("gpasswd failed: %s", strings.TrimSpace(string(out)))
	}
	return nil
}

// ═══════════════════════════════════════════════════════════════
// sshkey.list / add / remove : ~/.ssh/authorized_keys de l'user
// ═══════════════════════════════════════════════════════════════

type SshKeyListAction struct{}

func (a *SshKeyListAction) ID() string         { return "sshkey.list" }
func (a *SshKeyListAction) Capability() string { return "monitoring" }

func (a *SshKeyListAction) Validate(params map[string]interface{}) error {
	return validateUserName(params)
}

func (a *SshKeyListAction) Execute(params map[string]interface{}) (interface{}, error) {
	username := params["username"].(string)
	keys, err := readAuthorizedKeys(username)
	if err != nil {
		return nil, err
	}
	return map[string]interface{}{
		"username": username,
		"keys":     keys,
		"count":    len(keys),
	}, nil
}

type SshKeyAddAction struct{}

func (a *SshKeyAddAction) ID() string         { return "sshkey.add" }
func (a *SshKeyAddAction) Capability() string { return "system_control" }

func (a *SshKeyAddAction) Validate(params map[string]interface{}) error {
	if err := validateUserName(params); err != nil {
		return err
	}
	key, ok := params["key"].(string)
	if !ok || key == "" {
		return fmt.Errorf("required parameter 'key' missing")
	}
	key = strings.TrimSpace(key)
	if !isValidSshKeyLine(key) {
		return fmt.Errorf("invalid SSH public key format")
	}
	if len(key) > 8192 {
		return fmt.Errorf("key too long")
	}
	return nil
}

func (a *SshKeyAddAction) Execute(params map[string]interface{}) (interface{}, error) {
	username := params["username"].(string)
	key := strings.TrimSpace(params["key"].(string))

	u, err := user.Lookup(username)
	if err != nil {
		return nil, fmt.Errorf("user %s not found", username)
	}
	sshDir := filepath.Join(u.HomeDir, ".ssh")
	authFile := filepath.Join(sshDir, "authorized_keys")

	// Lire l'etat actuel
	existing, err := readAuthorizedKeys(username)
	if err != nil {
		return nil, err
	}
	// Dedup : si la cle exacte est deja presente, ne rien faire
	for _, k := range existing {
		if k.Line == key {
			return map[string]interface{}{"username": username, "already_present": true}, nil
		}
	}

	// Construire le nouveau contenu
	lines := make([]string, 0, len(existing)+1)
	for _, k := range existing {
		lines = append(lines, k.Line)
	}
	lines = append(lines, key)
	newContent := strings.Join(lines, "\n") + "\n"

	// Ecrire dans un tempfile du cote agent, puis sudo install dans le fichier cible
	tmp, err := os.CreateTemp("/var/lib/nexus-agent", "sshkey-*.tmp")
	if err != nil {
		return nil, fmt.Errorf("create temp: %w", err)
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.WriteString(newContent); err != nil {
		tmp.Close()
		return nil, err
	}
	tmp.Close()

	// 1. Creer le .ssh directory si absent (700, owned by user)
	if err := sudoRun("/usr/bin/install", "-d", "-m", "700", "-o", username, "-g", username, sshDir); err != nil {
		return nil, fmt.Errorf("mkdir .ssh: %w", err)
	}
	// 2. Installer le tempfile en tant que authorized_keys (600, owned by user)
	if err := sudoRun("/usr/bin/install", "-m", "600", "-o", username, "-g", username, tmp.Name(), authFile); err != nil {
		return nil, fmt.Errorf("install authorized_keys: %w", err)
	}

	return map[string]interface{}{
		"username": username,
		"added":    true,
	}, nil
}

type SshKeyRemoveAction struct{}

func (a *SshKeyRemoveAction) ID() string         { return "sshkey.remove" }
func (a *SshKeyRemoveAction) Capability() string { return "system_control" }

func (a *SshKeyRemoveAction) Validate(params map[string]interface{}) error {
	if err := validateUserName(params); err != nil {
		return err
	}
	fp, ok := params["fingerprint"].(string)
	if !ok || fp == "" {
		return fmt.Errorf("required parameter 'fingerprint' missing")
	}
	if !regexp.MustCompile(`^SHA256:[A-Za-z0-9+/=]{10,}$`).MatchString(fp) {
		return fmt.Errorf("invalid fingerprint format (expected SHA256:...)")
	}
	return nil
}

func (a *SshKeyRemoveAction) Execute(params map[string]interface{}) (interface{}, error) {
	username := params["username"].(string)
	targetFp := params["fingerprint"].(string)

	keys, err := readAuthorizedKeys(username)
	if err != nil {
		return nil, err
	}
	found := false
	filtered := []string{}
	for _, k := range keys {
		if k.Fingerprint == targetFp {
			found = true
			continue
		}
		filtered = append(filtered, k.Line)
	}
	if !found {
		return nil, fmt.Errorf("key with fingerprint %s not found", targetFp)
	}

	u, err := user.Lookup(username)
	if err != nil {
		return nil, fmt.Errorf("user %s not found", username)
	}
	authFile := filepath.Join(u.HomeDir, ".ssh", "authorized_keys")

	// Reecrire via tempfile + sudo install
	var newContent string
	if len(filtered) > 0 {
		newContent = strings.Join(filtered, "\n") + "\n"
	}
	tmp, err := os.CreateTemp("/var/lib/nexus-agent", "sshkey-*.tmp")
	if err != nil {
		return nil, fmt.Errorf("create temp: %w", err)
	}
	defer os.Remove(tmp.Name())
	tmp.WriteString(newContent)
	tmp.Close()

	if err := sudoRun("/usr/bin/install", "-m", "600", "-o", username, "-g", username, tmp.Name(), authFile); err != nil {
		return nil, fmt.Errorf("install authorized_keys: %w", err)
	}

	return map[string]interface{}{
		"username":    username,
		"fingerprint": targetFp,
		"removed":     true,
	}, nil
}

// sudoRun execute une commande via sudo -n et retourne une erreur lisible
func sudoRun(cmd string, args ...string) error {
	full := append([]string{"-n", cmd}, args...)
	c := exec.Command("sudo", full...)
	out, err := c.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s %s: %s", cmd, strings.Join(args, " "), strings.TrimSpace(string(out)))
	}
	return nil
}

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

type SshKey struct {
	Type        string `json:"type"`
	Comment     string `json:"comment"`
	Fingerprint string `json:"fingerprint"`
	Line        string `json:"-"`
}

func readAuthorizedKeys(username string) ([]SshKey, error) {
	u, err := user.Lookup(username)
	if err != nil {
		return nil, fmt.Errorf("user %s not found", username)
	}
	authFile := filepath.Join(u.HomeDir, ".ssh", "authorized_keys")

	// Lire via sudo (le fichier est owned par l'user cible)
	cmd := exec.Command("sudo", "-n", "/bin/cat", authFile)
	out, err := cmd.Output()
	if err != nil {
		// Fichier inexistant = liste vide
		return []SshKey{}, nil
	}

	keys := []SshKey{}
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		parts := strings.SplitN(line, " ", 3)
		if len(parts) < 2 {
			continue
		}
		keyType := parts[0]
		comment := ""
		if len(parts) == 3 {
			comment = parts[2]
		}
		fp := sshKeyFingerprint(line)
		keys = append(keys, SshKey{
			Type:        keyType,
			Comment:     comment,
			Fingerprint: fp,
			Line:        line,
		})
	}
	return keys, nil
}

// sshKeyFingerprint calcule le SHA256 via ssh-keygen -lf
func sshKeyFingerprint(line string) string {
	// Ecrire dans un tempfile
	f, err := os.CreateTemp("", "sshkey-*.pub")
	if err != nil {
		return ""
	}
	defer os.Remove(f.Name())
	f.WriteString(line + "\n")
	f.Close()
	cmd := exec.Command("/usr/bin/ssh-keygen", "-lf", f.Name())
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	// Format: "4096 SHA256:xxx comment (RSA)"
	parts := strings.Fields(string(out))
	if len(parts) < 2 {
		return ""
	}
	return parts[1]
}

func validateUserName(params map[string]interface{}) error {
	name, ok := params["username"].(string)
	if !ok || name == "" {
		return fmt.Errorf("required parameter 'username' missing")
	}
	if !userNameRegex.MatchString(name) {
		return fmt.Errorf("invalid username (must match POSIX login name rules)")
	}
	return nil
}

func isValidSshKeyLine(line string) bool {
	// Types standards : ssh-rsa, ssh-ed25519, ecdsa-sha2-*, ssh-dss (deprecated mais OK)
	// Format : <type> <base64> [comment]
	parts := strings.SplitN(line, " ", 3)
	if len(parts) < 2 {
		return false
	}
	validTypes := map[string]bool{
		"ssh-rsa":                true,
		"ssh-ed25519":            true,
		"ssh-dss":                true,
		"ecdsa-sha2-nistp256":    true,
		"ecdsa-sha2-nistp384":    true,
		"ecdsa-sha2-nistp521":    true,
		"sk-ssh-ed25519@openssh.com":       true,
		"sk-ecdsa-sha2-nistp256@openssh.com": true,
	}
	if !validTypes[parts[0]] {
		return false
	}
	// Le base64 ne doit contenir que des chars alphanum + - _ = + /
	if !regexp.MustCompile(`^[A-Za-z0-9+/=]+$`).MatchString(parts[1]) {
		return false
	}
	if len(parts[1]) < 40 {
		return false
	}
	return true
}

