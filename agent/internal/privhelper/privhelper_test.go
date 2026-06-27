package privhelper

import (
	"os"
	"path/filepath"
	"testing"
)

// NEXUS-AGENT-008 — preuve comportementale des deux gardes critiques :
//  (1) realpath AVANT usage (résout `..` et symlinks) ;
//  (2) comparaison de préfixe AVEC séparateur (/var/lib/nexus-agent/ — pas un
//      HasPrefix qui accepterait /var/lib/nexus-agent-evil/).

func TestResolveUnderStaging_SeparatorTrapAndTraversal(t *testing.T) {
	tmp := t.TempDir()
	staging := filepath.Join(tmp, "nexus-agent")
	evil := filepath.Join(tmp, "nexus-agent-evil") // même préfixe SANS séparateur
	if err := os.MkdirAll(staging, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(evil, 0700); err != nil {
		t.Fatal(err)
	}
	oldStaging := stagingDir
	stagingDir = staging
	t.Cleanup(func() { stagingDir = oldStaging })

	// (a) Fichier légitime sous staging → accepté.
	good := filepath.Join(staging, "netplan-x.tmp")
	os.WriteFile(good, []byte("ok"), 0600)
	if real, err := resolveUnderStaging(good); err != nil || real != good {
		t.Fatalf("fichier légitime rejeté: real=%q err=%v", real, err)
	}

	// (b) PIÈGE DU PRÉFIXE SANS SÉPARATEUR : nexus-agent-evil ne doit PAS passer.
	evilFile := filepath.Join(evil, "payload.tmp")
	os.WriteFile(evilFile, []byte("x"), 0600)
	if _, err := resolveUnderStaging(evilFile); err == nil {
		t.Fatal("nexus-agent-evil/ accepté — le préfixe est comparé SANS séparateur !")
	}

	// (c) Traversal via symlink : un lien sous staging pointant dehors → rejeté
	// (realpath résout AVANT la comparaison).
	outside := filepath.Join(tmp, "outside.tmp")
	os.WriteFile(outside, []byte("x"), 0600)
	link := filepath.Join(staging, "link.tmp")
	if err := os.Symlink(outside, link); err != nil {
		t.Fatal(err)
	}
	if _, err := resolveUnderStaging(link); err == nil {
		t.Fatal("symlink sortant accepté — realpath non appliqué avant la comparaison !")
	}

	// (d) Traversal `..` → rejeté.
	if _, err := resolveUnderStaging(filepath.Join(staging, "..", "outside.tmp")); err == nil {
		t.Fatal("traversal .. accepté")
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

	// Légitime : *.yaml directement sous netplanDir.
	if dst, err := validNetplanDst(filepath.Join(np, "99-nexus.yaml")); err != nil || dst != filepath.Join(np, "99-nexus.yaml") {
		t.Fatalf("dst légitime rejetée: %q err=%v", dst, err)
	}
	// Traversal `..` → le parent résolu n'est plus netplanDir → rejeté.
	if _, err := validNetplanDst(filepath.Join(np, "..", "evil.yaml")); err == nil {
		t.Fatal("traversal .. dans la dest netplan accepté")
	}
	// Mauvaise extension → rejeté.
	if _, err := validNetplanDst(filepath.Join(np, "x.txt")); err == nil {
		t.Fatal("extension non-.yaml acceptée")
	}
	// Sous-répertoire (slash dans le nom de base impossible via regex).
	if _, err := validNetplanDst(filepath.Join(np, "sub", "x.yaml")); err == nil {
		t.Fatal("dest dans un sous-répertoire acceptée")
	}
}

func TestUseraddRejectsOptionInjection(t *testing.T) {
	// Le login validé par loginRe interdit le `-` initial → `-o -u 0` ne passe pas
	// la validation (et `--` terminerait de toute façon le parsing d'options).
	for _, bad := range []string{"-o", "-u", "root -o -u 0", "ev;il", "UPPER", ""} {
		if loginRe.MatchString(bad) {
			t.Fatalf("login dangereux accepté par la regex: %q", bad)
		}
	}
	for _, ok := range []string{"alice", "_svc", "deploy-bot", "root"} {
		if !loginRe.MatchString(ok) {
			t.Fatalf("login légitime rejeté: %q", ok)
		}
	}
}
