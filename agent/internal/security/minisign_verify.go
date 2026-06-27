package security

import (
	"fmt"
	"os"
	"strings"

	"aead.dev/minisign"
)

// Vérification d'une accept-list de clés publiques minisign lue depuis un fichier
// LOCAL root-owned déposé par l'opérateur. Mutualisé entre l'auto-upgrade
// (release.pub) et la signature de script (script-signing.pub) : la pubkey vit
// hors du canal de commande, le backend n'y touche jamais, et chaque clé a un
// rôle/keypair distinct.

// LoadMinisignAcceptList lit et parse une accept-list minisign : une clé publique
// par ligne non vide. Lignes vides, commentaires (`#`) et en-tête `untrusted
// comment:` d'un fichier .pub collé tel quel sont ignorés. Renvoie TOUJOURS une
// erreur plutôt qu'une liste vide silencieuse → l'appelant échoue fermé : fichier
// absent, illisible, vide ou clé non parsable ⇒ erreur. Aucune variable d'env,
// aucun flag, aucun fallback.
func LoadMinisignAcceptList(path string) ([]minisign.PublicKey, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("lecture %s : %w", path, err)
	}
	var keys []minisign.PublicKey
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, "untrusted comment:") {
			continue
		}
		var pk minisign.PublicKey
		if err := pk.UnmarshalText([]byte(line)); err != nil {
			return nil, fmt.Errorf("clé publique invalide dans %s : %w", path, err)
		}
		keys = append(keys, pk) // accept-list = liste dès la 1re entrée (current[, next])
	}
	if len(keys) == 0 {
		return nil, fmt.Errorf("%s ne contient aucune clé publique utilisable", path)
	}
	return keys, nil
}

// VerifyMinisignAny applique un OR logique sur l'accept-list : la signature
// détachée est acceptée si N'IMPORTE quelle clé de la liste la valide.
// minisign.Verify gère le format brut (Ed) comme le pré-hashé Blake2b-512 (ED) et
// vérifie aussi la signature globale du trusted comment. Renvoie l'ID 64 bits de
// la clé qui a validé (pour journalisation du signataire) ; 0 si aucune.
func VerifyMinisignAny(keys []minisign.PublicKey, message, sig []byte) (ok bool, keyID uint64) {
	for _, pk := range keys {
		if minisign.Verify(pk, message, sig) {
			return true, pk.ID()
		}
	}
	return false, 0
}
