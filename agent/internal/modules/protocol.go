package modules

// Protocol IPC entre l'agent et les modules via Unix socket
// Chaque module est un binaire séparé qui écoute sur un socket Unix
// L'agent forward les requêtes après vérification des capabilities

// ModuleRequest est envoyé par l'agent au module
type ModuleRequest struct {
	RequestID string                 `json:"request_id"`
	ActionID  string                 `json:"action_id"` // ex: "docker.container.list"
	Params    map[string]interface{} `json:"params"`
}

// ModuleResponse est retourné par le module à l'agent
type ModuleResponse struct {
	RequestID string      `json:"request_id"`
	Success   bool        `json:"success"`
	Data      interface{} `json:"data,omitempty"`
	Error     string      `json:"error,omitempty"`
}

// ModuleInfo décrit un module et ses capabilities
type ModuleInfo struct {
	Name        string   `json:"name"`        // "nautilus", "zfs", "backup"
	Version     string   `json:"version"`
	Description string   `json:"description"`
	Capability  string   `json:"capability"`  // La capability que ce module fournit
	Actions     []string `json:"actions"`     // Liste des action_ids supportés
}

// ModuleStatus représente l'état d'un module
type ModuleStatus struct {
	Name      string `json:"name"`
	Running   bool   `json:"running"`
	PID       int    `json:"pid,omitempty"`
	Socket    string `json:"socket"`
	Version   string `json:"version"`
	LastError string `json:"last_error,omitempty"`
}
