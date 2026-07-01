package security

import (
	"fmt"
	"os"
	"strings"

	"aead.dev/minisign"
)

// Verification of a minisign public-key accept-list read from a LOCAL root-owned
// file deposited by the operator. Shared between auto-upgrade (release.pub) and
// script signing (script-signing.pub): the pubkey lives outside the command
// channel, the backend never touches it, and each key has a distinct role/keypair.

// LoadMinisignAcceptList reads and parses a minisign accept-list: one public key
// per non-empty line. Empty lines, comments (`#`) and the `untrusted comment:`
// header of a .pub file pasted as-is are ignored. ALWAYS returns an error rather
// than a silent empty list → the caller fails closed: missing, unreadable, empty
// file or unparsable key ⇒ error. No env variable, no flag, no fallback.
func LoadMinisignAcceptList(path string) ([]minisign.PublicKey, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	var keys []minisign.PublicKey
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, "untrusted comment:") {
			continue
		}
		var pk minisign.PublicKey
		if err := pk.UnmarshalText([]byte(line)); err != nil {
			return nil, fmt.Errorf("invalid public key in %s: %w", path, err)
		}
		keys = append(keys, pk) // accept-list = list from the 1st entry (current[, next])
	}
	if len(keys) == 0 {
		return nil, fmt.Errorf("%s contains no usable public key", path)
	}
	return keys, nil
}

// VerifyMinisignAny applies a logical OR over the accept-list: the detached
// signature is accepted if ANY key in the list validates it.
// minisign.Verify handles both the raw format (Ed) and the pre-hashed Blake2b-512
// (ED), and also verifies the global signature of the trusted comment. Returns the
// 64-bit ID of the key that validated (for signer logging); 0 if none.
func VerifyMinisignAny(keys []minisign.PublicKey, message, sig []byte) (ok bool, keyID uint64) {
	for _, pk := range keys {
		if minisign.Verify(pk, message, sig) {
			return true, pk.ID()
		}
	}
	return false, 0
}
