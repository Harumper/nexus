package actions

import "testing"

const sampleSs = `LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=800,fd=3))
LISTEN 0 128 [::]:22 [::]:* users:(("sshd",pid=800,fd=4))
LISTEN 0 244 127.0.0.1:5432 0.0.0.0:* users:(("postgres",pid=900,fd=5))
LISTEN 0 4096 127.0.0.53%lo:53 0.0.0.0:* users:(("systemd-resolve",pid=700,fd=14))
LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=1000,fd=6))
`

func TestParseSsListening(t *testing.T) {
	svcs := parseSsListening(sampleSs)
	if len(svcs) != 5 {
		t.Fatalf("got %d services, want 5", len(svcs))
	}

	byKey := map[string]listeningService{}
	for _, s := range svcs {
		byKey[s.Address+":"+s.Port] = s
	}

	ssh := byKey["0.0.0.0:22"]
	if !ssh.IsSSH || !ssh.Exposed || ssh.Process != "sshd" {
		t.Errorf("sshd 0.0.0.0:22 = %+v", ssh)
	}

	pg := byKey["127.0.0.1:5432"]
	if pg.Exposed {
		t.Errorf("postgres sur loopback ne doit pas être exposed: %+v", pg)
	}
	if pg.Process != "postgres" {
		t.Errorf("postgres process = %q", pg.Process)
	}

	resolved := byKey["127.0.0.53%lo:53"]
	if resolved.Exposed {
		t.Errorf("systemd-resolve %%lo ne doit pas être exposed: %+v", resolved)
	}

	nginx := byKey["0.0.0.0:80"]
	if !nginx.Exposed || nginx.Process != "nginx" || nginx.IsSSH {
		t.Errorf("nginx 0.0.0.0:80 = %+v", nginx)
	}
}

func TestParseSsListeningIgnoresGarbage(t *testing.T) {
	if got := len(parseSsListening("")); got != 0 {
		t.Errorf("empty -> %d, want 0", got)
	}
	if got := len(parseSsListening("incomplete line\n")); got != 0 {
		t.Errorf("garbage -> %d, want 0", got)
	}
}
