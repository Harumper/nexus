package main

// Module Nautilus pour Nexus
// Gestion Docker : containers, images, stacks
//
// Ce module est un binaire séparé qui communique avec l'agent Nexus
// via un socket Unix. L'agent vérifie les capabilities avant de
// forwarder les requêtes.
//
// Usage :
//   nexus-module-nautilus --socket /opt/nexus/modules/nautilus.sock
//
// Le module s'enregistre avec la capability "docker" et expose
// les actions suivantes :
//   docker.container.list    - Lister les containers
//   docker.container.start   - Démarrer un container
//   docker.container.stop    - Arrêter un container
//   docker.container.restart - Redémarrer un container
//   docker.container.logs    - Voir les logs d'un container
//   docker.container.stats   - Stats d'un container
//   docker.image.list        - Lister les images
//   docker.stack.list        - Lister les stacks compose
//   docker.stack.up          - Démarrer une stack
//   docker.stack.down        - Arrêter une stack

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net"
	"os"
	"os/signal"
	"syscall"
)

var Version = "0.1.0"

type Request struct {
	RequestID string                 `json:"request_id"`
	ActionID  string                 `json:"action_id"`
	Params    map[string]interface{} `json:"params"`
}

type Response struct {
	RequestID string      `json:"request_id"`
	Success   bool        `json:"success"`
	Data      interface{} `json:"data,omitempty"`
	Error     string      `json:"error,omitempty"`
}

type ModuleInfo struct {
	Name        string   `json:"name"`
	Version     string   `json:"version"`
	Description string   `json:"description"`
	Capability  string   `json:"capability"`
	Actions     []string `json:"actions"`
}

func main() {
	socketPath := flag.String("socket", "/opt/nexus/modules/nautilus.sock", "Unix socket path")
	flag.Parse()

	log.Printf("[Nautilus] Module v%s starting...", Version)

	// Nettoyer le socket existant
	os.Remove(*socketPath)

	listener, err := net.Listen("unix", *socketPath)
	if err != nil {
		log.Fatalf("Failed to listen on %s: %v", *socketPath, err)
	}
	defer listener.Close()
	defer os.Remove(*socketPath)

	// Permissions restrictives sur le socket
	os.Chmod(*socketPath, 0600)

	log.Printf("[Nautilus] Listening on %s", *socketPath)

	// Gestion graceful shutdown
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigCh
		log.Println("[Nautilus] Shutting down...")
		listener.Close()
		os.Exit(0)
	}()

	for {
		conn, err := listener.Accept()
		if err != nil {
			log.Printf("[Nautilus] Accept error: %v", err)
			continue
		}
		go handleConnection(conn)
	}
}

func handleConnection(conn net.Conn) {
	defer conn.Close()
	decoder := json.NewDecoder(conn)
	encoder := json.NewEncoder(conn)

	for {
		var req Request
		if err := decoder.Decode(&req); err != nil {
			return // Connection fermée
		}

		resp := handleRequest(req)
		if err := encoder.Encode(resp); err != nil {
			return
		}
	}
}

func handleRequest(req Request) Response {
	switch req.ActionID {
	case "_module.info":
		return Response{
			RequestID: req.RequestID,
			Success:   true,
			Data: ModuleInfo{
				Name:        "nautilus",
				Version:     Version,
				Description: "Gestion Docker : containers, images, stacks",
				Capability:  "docker",
				Actions: []string{
					"docker.container.list",
					"docker.container.start",
					"docker.container.stop",
					"docker.container.restart",
					"docker.container.logs",
					"docker.container.stats",
					"docker.image.list",
					"docker.stack.list",
					"docker.stack.up",
					"docker.stack.down",
				},
			},
		}

	case "docker.container.list":
		return listContainers(req)

	case "docker.container.start":
		return containerAction(req, "start")

	case "docker.container.stop":
		return containerAction(req, "stop")

	case "docker.container.restart":
		return containerAction(req, "restart")

	case "docker.image.list":
		return listImages(req)

	default:
		return Response{
			RequestID: req.RequestID,
			Success:   false,
			Error:     fmt.Sprintf("unknown action: %s", req.ActionID),
		}
	}
}

// ===================== Actions Docker (commandes HARDCODÉES) =====================
// Chaque action utilise des chemins absolus et des arguments fixes

func listContainers(req Request) Response {
	// Chemin ABSOLU, arguments HARDCODÉS
	// En production : utiliser le Docker SDK Go au lieu de exec
	// Pour le skeleton, on retourne un placeholder
	return Response{
		RequestID: req.RequestID,
		Success:   true,
		Data: map[string]interface{}{
			"note": "Skeleton module - implement with Docker SDK",
			"containers": []interface{}{},
		},
	}
}

func containerAction(req Request, action string) Response {
	containerID, ok := req.Params["container_id"].(string)
	if !ok || containerID == "" {
		return Response{
			RequestID: req.RequestID,
			Success:   false,
			Error:     "container_id is required",
		}
	}

	// En production : utiliser le Docker SDK Go
	return Response{
		RequestID: req.RequestID,
		Success:   true,
		Data: map[string]interface{}{
			"note":         "Skeleton module - implement with Docker SDK",
			"action":       action,
			"container_id": containerID,
		},
	}
}

func listImages(req Request) Response {
	return Response{
		RequestID: req.RequestID,
		Success:   true,
		Data: map[string]interface{}{
			"note":   "Skeleton module - implement with Docker SDK",
			"images": []interface{}{},
		},
	}
}
