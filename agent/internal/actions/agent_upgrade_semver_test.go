package actions

import "testing"

func TestIsDowngrade(t *testing.T) {
	cases := []struct {
		target, current string
		want            bool
	}{
		{"1.2.3", "1.2.4", true},         // lower patch
		{"1.2.3", "1.3.0", true},         // lower minor
		{"1.0.0", "2.0.0", true},         // lower major
		{"1.2.4", "1.2.3", false},        // upgrade
		{"1.2.3", "1.2.3", false},        // identical
		{"1.2.3", "dev", false},          // current dev → never blocked
		{"1.2.3-5-gabc", "1.2.3", false}, // build metadata ignored (same core)
		{"bad", "1.2.3", false},          // unparsable target → not a downgrade
	}
	for _, c := range cases {
		if got := isDowngrade(c.target, c.current); got != c.want {
			t.Errorf("isDowngrade(%q,%q)=%v want %v", c.target, c.current, got, c.want)
		}
	}
}
