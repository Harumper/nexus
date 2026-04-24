package actions

import (
	"fmt"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
)

func init() { Register(&SystemLogsAction{}) }

// Format accepte pour 'since' : "5m", "1h", "2d", "today", "yesterday", ou ISO8601
var sinceRegex = regexp.MustCompile(`^(\d+[smhd]|today|yesterday|\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?)$`)

// Nom de service valide (meme que services.go)
var logsServiceRegex = regexp.MustCompile(`^[a-zA-Z0-9@_.\-]+$`)

type SystemLogsAction struct{}

func (a *SystemLogsAction) ID() string         { return "system.logs" }
func (a *SystemLogsAction) Capability() string { return "monitoring" }

func (a *SystemLogsAction) Validate(params map[string]interface{}) error {
	service, ok := params["service"].(string)
	if !ok || service == "" {
		return fmt.Errorf("required parameter 'service' missing")
	}
	if len(service) > 128 {
		return fmt.Errorf("service name too long")
	}
	if !logsServiceRegex.MatchString(service) {
		return fmt.Errorf("invalid service name")
	}
	if linesRaw, ok := params["lines"]; ok {
		lines, _ := toInt(linesRaw)
		if lines < 1 || lines > 1000 {
			return fmt.Errorf("lines must be between 1 and 1000")
		}
	}
	if sinceRaw, ok := params["since"]; ok {
		if since, _ := sinceRaw.(string); since != "" && !sinceRegex.MatchString(since) {
			return fmt.Errorf("invalid 'since' format (expected 5m, 1h, 2d, today, yesterday, or YYYY-MM-DD)")
		}
	}
	return nil
}

func (a *SystemLogsAction) Execute(params map[string]interface{}) (interface{}, error) {
	service := params["service"].(string)
	lines := 100
	if v, ok := params["lines"]; ok {
		if n, ok2 := toInt(v); ok2 && n > 0 {
			lines = n
		}
	}
	since, _ := params["since"].(string)

	args := []string{"-u", service, "-n", strconv.Itoa(lines), "--no-pager", "-o", "short-iso"}
	if since != "" {
		args = append(args, "--since", since)
	}

	cmd := exec.Command("/usr/bin/journalctl", args...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		// journalctl peut retourner exit != 0 mais le texte reste utile
		outStr := string(output)
		if strings.Contains(outStr, "No journal files were found") {
			return nil, fmt.Errorf("no journal access (agent must be in systemd-journal group; restart agent after install)")
		}
		// fallback : retourner quand meme
	}

	lines2 := strings.Split(strings.TrimRight(string(output), "\n"), "\n")
	truncated := len(lines2) >= lines

	return map[string]interface{}{
		"service":   service,
		"lines":     lines2,
		"count":     len(lines2),
		"truncated": truncated,
	}, nil
}

func toInt(v interface{}) (int, bool) {
	switch n := v.(type) {
	case int:
		return n, true
	case int64:
		return int(n), true
	case float64:
		return int(n), true
	case string:
		i, err := strconv.Atoi(n)
		return i, err == nil
	}
	return 0, false
}
