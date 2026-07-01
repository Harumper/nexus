package privhelper

import (
	"os"
	"path/filepath"
	"testing"
)

// NEXUS-AGENT-008 — behavioral proof of the two critical guards:
//  (1) realpath BEFORE use (resolves `..` and symlinks);
//  (2) prefix comparison WITH separator (/var/lib/nexus-agent/ — not a
//      HasPrefix that would accept /var/lib/nexus-agent-evil/).

func TestResolveUnderStaging_SeparatorTrapAndTraversal(t *testing.T) {
	tmp := t.TempDir()
	staging := filepath.Join(tmp, "nexus-agent")
	evil := filepath.Join(tmp, "nexus-agent-evil") // same prefix WITHOUT separator
	if err := os.MkdirAll(staging, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(evil, 0700); err != nil {
		t.Fatal(err)
	}
	oldStaging := stagingDir
	stagingDir = staging
	t.Cleanup(func() { stagingDir = oldStaging })

	// (a) Legitimate file under staging → accepted.
	good := filepath.Join(staging, "netplan-x.tmp")
	os.WriteFile(good, []byte("ok"), 0600)
	if real, err := resolveUnderStaging(good); err != nil || real != good {
		t.Fatalf("legitimate file rejected: real=%q err=%v", real, err)
	}

	// (b) SEPARATOR-LESS PREFIX TRAP: nexus-agent-evil must NOT pass.
	evilFile := filepath.Join(evil, "payload.tmp")
	os.WriteFile(evilFile, []byte("x"), 0600)
	if _, err := resolveUnderStaging(evilFile); err == nil {
		t.Fatal("nexus-agent-evil/ accepted — the prefix is compared WITHOUT separator!")
	}

	// (c) Traversal via symlink: a link under staging pointing outside → rejected
	// (realpath resolves BEFORE the comparison).
	outside := filepath.Join(tmp, "outside.tmp")
	os.WriteFile(outside, []byte("x"), 0600)
	link := filepath.Join(staging, "link.tmp")
	if err := os.Symlink(outside, link); err != nil {
		t.Fatal(err)
	}
	if _, err := resolveUnderStaging(link); err == nil {
		t.Fatal("outgoing symlink accepted — realpath not applied before the comparison!")
	}

	// (d) Traversal `..` → rejected.
	if _, err := resolveUnderStaging(filepath.Join(staging, "..", "outside.tmp")); err == nil {
		t.Fatal("traversal .. accepted")
	}
}

func TestValidNetplanDst_NoTraversal(t *testing.T) {
	tmp := t.TempDir()
	np := filepath.Join(tmp, "netplan")
	if err := os.MkdirAll(np, 0755); err != nil {
		t.Fatal(err)
	}
	oldNp := netplanDir
	netplanDir = np
	t.Cleanup(func() { netplanDir = oldNp })

	// Legitimate: *.yaml directly under netplanDir.
	if dst, err := validNetplanDst(filepath.Join(np, "99-nexus.yaml")); err != nil || dst != filepath.Join(np, "99-nexus.yaml") {
		t.Fatalf("legitimate dst rejected: %q err=%v", dst, err)
	}
	// Traversal `..` → the resolved parent is no longer netplanDir → rejected.
	if _, err := validNetplanDst(filepath.Join(np, "..", "evil.yaml")); err == nil {
		t.Fatal("traversal .. in the netplan dest accepted")
	}
	// Wrong extension → rejected.
	if _, err := validNetplanDst(filepath.Join(np, "x.txt")); err == nil {
		t.Fatal("non-.yaml extension accepted")
	}
	// Subdirectory (slash in the base name impossible via regex).
	if _, err := validNetplanDst(filepath.Join(np, "sub", "x.yaml")); err == nil {
		t.Fatal("dest in a subdirectory accepted")
	}
}

func TestUseraddRejectsOptionInjection(t *testing.T) {
	// The login validated by loginRe forbids the leading `-` → `-o -u 0` doesn't
	// pass validation (and `--` would end option parsing anyway).
	for _, bad := range []string{"-o", "-u", "root -o -u 0", "ev;il", "UPPER", ""} {
		if loginRe.MatchString(bad) {
			t.Fatalf("dangerous login accepted by the regex: %q", bad)
		}
	}
	for _, ok := range []string{"alice", "_svc", "deploy-bot", "root"} {
		if !loginRe.MatchString(ok) {
			t.Fatalf("legitimate login rejected: %q", ok)
		}
	}
}

// NEXUS-AGENT-006 — the svc wrapper refuses in CODE (before any exec) protected
// units on destructive verbs, units with a leading dash (option injection) and
// unknown verbs. doSvc returns 2 (fail) in these cases.
func TestDoSvc_RefusesProtectedAndMalformed(t *testing.T) {
	refused := [][]string{
		{"stop", "ssh"},         // admin lock-out
		{"restart", "sshd"},     // admin lock-out
		{"stop", "nexus-agent"}, // self-DoS (consistency with AGENT-004)
		{"reload", "ssh.service"},
		{"disable", "sshd"},
		{"stop", "--no-ask-password"}, // leading dash → reject (no injectable option)
		{"stop", "-x"},
		{"bogus", "foo"}, // unenumerated verb
		{"stop"},         // invalid arity
		{"stop", "a b"},  // space → not a single token
	}
	for _, args := range refused {
		if rc := doSvc(args); rc == 0 {
			t.Errorf("doSvc(%v) = 0, expected refusal (rc != 0)", args)
		}
	}
}

// Protected units remain allowed on START/ENABLE (non-destructive) —
// validation passes (the systemctl exec may fail in CI, out of scope).
func TestDoSvc_AllowsStartOnProtected_PassesValidation(t *testing.T) {
	// We ONLY check that validation doesn't refuse (rc==2 = validation fail).
	// start on ssh is legitimate (starting, not stopping).
	if rc := doSvc([]string{"start", "ssh"}); rc == 2 {
		t.Errorf("doSvc(start ssh) refused in validation while a start is allowed")
	}
}
