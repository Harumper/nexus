package actions

import "testing"

func TestIsDowngrade(t *testing.T) {
	cases := []struct{ target, current string; want bool }{
		{"1.2.3", "1.2.4", true},   // patch inférieur
		{"1.2.3", "1.3.0", true},   // minor inférieur
		{"1.0.0", "2.0.0", true},   // major inférieur
		{"1.2.4", "1.2.3", false},  // upgrade
		{"1.2.3", "1.2.3", false},  // identique
		{"1.2.3", "dev", false},    // current dev → jamais bloqué
		{"1.2.3-5-gabc", "1.2.3", false}, // build metadata ignorée (même core)
		{"bad", "1.2.3", false},    // target non parsable → pas un downgrade
	}
	for _, c := range cases {
		if got := isDowngrade(c.target, c.current); got != c.want {
			t.Errorf("isDowngrade(%q,%q)=%v want %v", c.target, c.current, got, c.want)
		}
	}
}
