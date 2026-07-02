package actions

import (
	"os"
	"strings"
	"testing"
)

func TestValidateLokiShipParams(t *testing.T) {
	cases := []struct {
		name string
		p    LokiShipParams
		ok   bool
	}{
		{"valid ip", LokiShipParams{Host: "192.0.2.10", Port: "3100"}, true},
		{"valid host", LokiShipParams{Host: "loki.example.com", Port: "3100", Tenant: "team-a"}, true},
		{"missing port", LokiShipParams{Host: "192.0.2.10", Port: ""}, false},
		{"bad port", LokiShipParams{Host: "192.0.2.10", Port: "31x0"}, false},
		{"host injection space", LokiShipParams{Host: "192.0.2.10 evil", Port: "3100"}, false},
		{"host injection newline", LokiShipParams{Host: "192.0.2.10\n  tls: off", Port: "3100"}, false},
		{"tenant injection", LokiShipParams{Host: "h", Port: "3100", Tenant: "a b"}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := validateLokiShipParams(tc.p)
			if (err == nil) != tc.ok {
				t.Errorf("ok=%v but err=%v", tc.ok, err)
			}
		})
	}
}

func TestBuildFluentBitConfig(t *testing.T) {
	cfg := buildFluentBitConfig(LokiShipParams{Host: "192.0.2.10", Port: "3100", TLS: false})
	for _, want := range []string{
		"name: systemd", "read_from_tail: on", "record_modifier",
		"Allowlist_key: MESSAGE", "name: loki",
		"host: 192.0.2.10", "port: 3100", "tls: off",
		"labels: job=nexus-fleet, host=$HOSTNAME",
		"structured_metadata: ident=$SYSLOG_IDENTIFIER, pid=$PID",
		"drop_single_key: raw",
	} {
		if !strings.Contains(cfg, want) {
			t.Errorf("config missing %q", want)
		}
	}
	// No-auth case must NOT emit tenant/auth lines.
	if strings.Contains(cfg, "tenant_id") || strings.Contains(cfg, "http_user") {
		t.Errorf("no-auth config should not contain tenant_id/http_user")
	}

	// TLS + tenant variant.
	tls := buildFluentBitConfig(LokiShipParams{Host: "loki.x", Port: "443", TLS: true, Tenant: "team-a"})
	for _, want := range []string{"tls: on", "tls.verify: on", "tenant_id: team-a"} {
		if !strings.Contains(tls, want) {
			t.Errorf("tls/tenant config missing %q", want)
		}
	}

	// Integration hook: dump the rendered config so a real `fluent-bit --dry-run`
	// can validate it (see the container check).
	if p := os.Getenv("NEXUS_FLB_DUMP"); p != "" {
		if err := os.WriteFile(p, []byte(cfg), 0644); err != nil {
			t.Fatalf("dump config: %v", err)
		}
	}
}
