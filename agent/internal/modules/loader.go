package modules

import (
	"encoding/json"
	"fmt"
	"log"
	"net"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Module représente un module chargé et connecté
type Module struct {
	Info   ModuleInfo
	Socket string
	conn   net.Conn
	mu     sync.Mutex
}

// Loader gère le chargement et la communication avec les modules
type Loader struct {
	mu         sync.RWMutex
	modules    map[string]*Module // name -> module
	socketDir  string
	actionMap  map[string]string  // action_id -> module name
}

func NewLoader(socketDir string) *Loader {
	return &Loader{
		modules:   make(map[string]*Module),
		socketDir: socketDir,
		actionMap: make(map[string]string),
	}
}

// Discover recherche les modules disponibles dans le répertoire des sockets
func (l *Loader) Discover() error {
	if err := os.MkdirAll(l.socketDir, 0700); err != nil {
		return fmt.Errorf("failed to create socket dir: %w", err)
	}

	// Chercher les fichiers .sock dans le répertoire
	entries, err := os.ReadDir(l.socketDir)
	if err != nil {
		return fmt.Errorf("failed to read socket dir: %w", err)
	}

	for _, entry := range entries {
		if filepath.Ext(entry.Name()) != ".sock" {
			continue
		}

		socketPath := filepath.Join(l.socketDir, entry.Name())
		moduleName := entry.Name()[:len(entry.Name())-5] // enlever .sock

		if err := l.connectModule(moduleName, socketPath); err != nil {
			log.Printf("[Modules] Failed to connect to %s: %v", moduleName, err)
			continue
		}
	}

	return nil
}

// connectModule se connecte à un module via son socket Unix
func (l *Loader) connectModule(name, socketPath string) error {
	conn, err := net.DialTimeout("unix", socketPath, 5*time.Second)
	if err != nil {
		return fmt.Errorf("connect failed: %w", err)
	}

	// Demander les infos du module
	infoReq := ModuleRequest{
		RequestID: "init",
		ActionID:  "_module.info",
	}

	if err := json.NewEncoder(conn).Encode(infoReq); err != nil {
		conn.Close()
		return fmt.Errorf("info request failed: %w", err)
	}

	var infoResp ModuleResponse
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	if err := json.NewDecoder(conn).Decode(&infoResp); err != nil {
		conn.Close()
		return fmt.Errorf("info response failed: %w", err)
	}
	conn.SetReadDeadline(time.Time{}) // reset deadline

	if !infoResp.Success {
		conn.Close()
		return fmt.Errorf("module returned error: %s", infoResp.Error)
	}

	// Parser les infos
	infoBytes, _ := json.Marshal(infoResp.Data)
	var info ModuleInfo
	if err := json.Unmarshal(infoBytes, &info); err != nil {
		conn.Close()
		return fmt.Errorf("invalid module info: %w", err)
	}

	module := &Module{
		Info:   info,
		Socket: socketPath,
		conn:   conn,
	}

	l.mu.Lock()
	l.modules[name] = module
	for _, actionID := range info.Actions {
		l.actionMap[actionID] = name
	}
	l.mu.Unlock()

	log.Printf("[Modules] Connected: %s v%s (%d actions, capability: %s)",
		info.Name, info.Version, len(info.Actions), info.Capability)

	return nil
}

// GetModule retourne un module par son nom
func (l *Loader) GetModule(name string) (*Module, bool) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	m, ok := l.modules[name]
	return m, ok
}

// GetModuleForAction retourne le module qui gère une action donnée
func (l *Loader) GetModuleForAction(actionID string) (*Module, bool) {
	l.mu.RLock()
	name, ok := l.actionMap[actionID]
	l.mu.RUnlock()
	if !ok {
		return nil, false
	}
	return l.GetModule(name)
}

// ExecuteAction envoie une requête à un module et attend la réponse
func (l *Loader) ExecuteAction(actionID string, requestID string, params map[string]interface{}) (interface{}, error) {
	module, ok := l.GetModuleForAction(actionID)
	if !ok {
		return nil, fmt.Errorf("no module handles action '%s'", actionID)
	}

	module.mu.Lock()
	defer module.mu.Unlock()

	req := ModuleRequest{
		RequestID: requestID,
		ActionID:  actionID,
		Params:    params,
	}

	// Envoyer la requête
	if err := json.NewEncoder(module.conn).Encode(req); err != nil {
		return nil, fmt.Errorf("send to module '%s' failed: %w", module.Info.Name, err)
	}

	// Lire la réponse (timeout 5 minutes pour les actions longues)
	module.conn.SetReadDeadline(time.Now().Add(5 * time.Minute))
	var resp ModuleResponse
	if err := json.NewDecoder(module.conn).Decode(&resp); err != nil {
		return nil, fmt.Errorf("read from module '%s' failed: %w", module.Info.Name, err)
	}
	module.conn.SetReadDeadline(time.Time{})

	if !resp.Success {
		return nil, fmt.Errorf("module '%s' error: %s", module.Info.Name, resp.Error)
	}

	return resp.Data, nil
}

// ListModules retourne l'état de tous les modules
func (l *Loader) ListModules() []ModuleStatus {
	l.mu.RLock()
	defer l.mu.RUnlock()

	var statuses []ModuleStatus
	for name, m := range l.modules {
		statuses = append(statuses, ModuleStatus{
			Name:    name,
			Running: m.conn != nil,
			Socket:  m.Socket,
			Version: m.Info.Version,
		})
	}
	return statuses
}

// GetAllActions retourne toutes les actions fournies par les modules
func (l *Loader) GetAllActions() map[string]string {
	l.mu.RLock()
	defer l.mu.RUnlock()
	result := make(map[string]string)
	for action, module := range l.actionMap {
		result[action] = module
	}
	return result
}

// GetCapabilities retourne les capabilities fournies par les modules
func (l *Loader) GetCapabilities() []string {
	l.mu.RLock()
	defer l.mu.RUnlock()
	seen := make(map[string]bool)
	var caps []string
	for _, m := range l.modules {
		if !seen[m.Info.Capability] {
			caps = append(caps, m.Info.Capability)
			seen[m.Info.Capability] = true
		}
	}
	return caps
}

// Close ferme toutes les connexions aux modules
func (l *Loader) Close() {
	l.mu.Lock()
	defer l.mu.Unlock()
	for name, m := range l.modules {
		if m.conn != nil {
			m.conn.Close()
			log.Printf("[Modules] Disconnected: %s", name)
		}
	}
}
