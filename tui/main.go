// remux-tui is a cross-platform terminal client for remux servers.
//
// It connects to one or more remux hosts via WebSocket and provides
// a unified terminal session view using bubbletea.
//
// Usage:
//
//	remux-tui connect <url>             Connect to a single host
//	remux-tui connect                   Connect to all saved hosts
//	remux-tui hosts add <name> <url>    Save a host
//	remux-tui hosts list                List saved hosts
//	remux-tui hosts remove <name>       Remove a saved host
package main

import (
	"fmt"
	"net/url"
	"os"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/eisber/remux/tui/client"
	"github.com/eisber/remux/tui/config"
	"github.com/eisber/remux/tui/ui"
)

func main() {
	if len(os.Args) < 2 {
		printUsage()
		os.Exit(1)
	}

	switch os.Args[1] {
	case "connect":
		runConnect(os.Args[2:])
	case "hosts":
		runHosts(os.Args[2:])
	case "version":
		fmt.Println("remux-tui v0.1.0")
	case "help", "--help", "-h":
		printUsage()
	default:
		// If it looks like a URL, treat it as `connect <url>`.
		if strings.HasPrefix(os.Args[1], "http") || strings.HasPrefix(os.Args[1], "ws") {
			runConnect(os.Args[1:])
		} else {
			fmt.Fprintf(os.Stderr, "unknown command: %s\n", os.Args[1])
			printUsage()
			os.Exit(1)
		}
	}
}

func printUsage() {
	fmt.Println(`remux-tui — cross-platform terminal client for remux servers

Usage:
  remux-tui connect [url]           Connect to a host (or all saved hosts)
  remux-tui hosts add <name> <url>  Save a host connection
  remux-tui hosts list              List saved hosts
  remux-tui hosts remove <name>     Remove a saved host
  remux-tui version                 Show version

Keyboard shortcuts (when connected):
  Ctrl-O    Session picker (switch between sessions/hosts)
  Ctrl-D    Detach (quit client, sessions keep running)

Environment:
  REMUX_PASSWORD   Password for authentication`)
}

func runConnect(args []string) {
	manager := client.NewHostManager()
	defer manager.Close()

	password := os.Getenv("REMUX_PASSWORD")

	if len(args) > 0 {
		// Connect to a single URL.
		rawURL := args[0]
		host, err := parseHostURL(rawURL)
		if err != nil {
			fmt.Fprintf(os.Stderr, "invalid URL: %s\n", err)
			os.Exit(1)
		}

		model := tui.NewModel(manager)
		p := tea.NewProgram(model, tea.WithAltScreen())

		if err := manager.AddHost(host, password); err != nil {
			fmt.Fprintf(os.Stderr, "failed to connect to %s: %s\n", host.Name, err)
			os.Exit(1)
		}

		conn := manager.GetConnection(host.Name)
		tui.SetupCallbacks(manager, p)
		tui.SetupConnectionCallbacks(conn, p)

		if _, err := p.Run(); err != nil {
			fmt.Fprintf(os.Stderr, "error: %s\n", err)
			os.Exit(1)
		}
		return
	}

	// Connect to all saved hosts.
	cfgPath := config.DefaultConfigPath()
	cfg, err := config.Load(cfgPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "failed to load config: %s\n", err)
		os.Exit(1)
	}

	if len(cfg.Hosts) == 0 {
		fmt.Println("No saved hosts. Use:")
		fmt.Println("  remux-tui hosts add <name> <url>")
		fmt.Println("  remux-tui connect <url>")
		os.Exit(0)
	}

	model := tui.NewModel(manager)
	p := tea.NewProgram(model, tea.WithAltScreen())

	for _, host := range cfg.Hosts {
		if err := manager.AddHost(host, password); err != nil {
			fmt.Fprintf(os.Stderr, "warning: failed to connect to %s: %s\n", host.Name, err)
			continue
		}
		conn := manager.GetConnection(host.Name)
		tui.SetupConnectionCallbacks(conn, p)
	}

	tui.SetupCallbacks(manager, p)

	if _, err := p.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "error: %s\n", err)
		os.Exit(1)
	}
}

func runHosts(args []string) {
	cfgPath := config.DefaultConfigPath()

	if len(args) == 0 {
		args = []string{"list"}
	}

	switch args[0] {
	case "add":
		if len(args) < 3 {
			fmt.Fprintln(os.Stderr, "usage: remux-tui hosts add <name> <url>")
			os.Exit(1)
		}
		name := args[1]
		rawURL := args[2]
		host, err := parseHostURL(rawURL)
		if err != nil {
			fmt.Fprintf(os.Stderr, "invalid URL: %s\n", err)
			os.Exit(1)
		}
		host.Name = name

		cfg, err := config.Load(cfgPath)
		if err != nil {
			fmt.Fprintf(os.Stderr, "failed to load config: %s\n", err)
			os.Exit(1)
		}

		// Replace existing host with same name.
		replaced := false
		for i, h := range cfg.Hosts {
			if h.Name == name {
				cfg.Hosts[i] = host
				replaced = true
				break
			}
		}
		if !replaced {
			cfg.Hosts = append(cfg.Hosts, host)
		}

		if err := config.Save(cfgPath, cfg); err != nil {
			fmt.Fprintf(os.Stderr, "failed to save config: %s\n", err)
			os.Exit(1)
		}
		fmt.Printf("saved host %q → %s\n", name, host.URL)

	case "list":
		cfg, err := config.Load(cfgPath)
		if err != nil {
			fmt.Fprintf(os.Stderr, "failed to load config: %s\n", err)
			os.Exit(1)
		}
		if len(cfg.Hosts) == 0 {
			fmt.Println("no saved hosts")
			return
		}
		for _, h := range cfg.Hosts {
			fmt.Printf("  %s → %s\n", h.Name, h.URL)
		}

	case "remove":
		if len(args) < 2 {
			fmt.Fprintln(os.Stderr, "usage: remux-tui hosts remove <name>")
			os.Exit(1)
		}
		name := args[1]
		cfg, err := config.Load(cfgPath)
		if err != nil {
			fmt.Fprintf(os.Stderr, "failed to load config: %s\n", err)
			os.Exit(1)
		}
		filtered := cfg.Hosts[:0]
		found := false
		for _, h := range cfg.Hosts {
			if h.Name == name {
				found = true
				continue
			}
			filtered = append(filtered, h)
		}
		if !found {
			fmt.Fprintf(os.Stderr, "host %q not found\n", name)
			os.Exit(1)
		}
		cfg.Hosts = filtered
		if err := config.Save(cfgPath, cfg); err != nil {
			fmt.Fprintf(os.Stderr, "failed to save config: %s\n", err)
			os.Exit(1)
		}
		fmt.Printf("removed host %q\n", name)

	default:
		fmt.Fprintf(os.Stderr, "unknown hosts command: %s\n", args[0])
		os.Exit(1)
	}
}

// parseHostURL extracts a Host from a URL, pulling the token from the query string.
func parseHostURL(rawURL string) (client.Host, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return client.Host{}, err
	}

	token := u.Query().Get("token")
	// Remove token from URL for storage.
	q := u.Query()
	q.Del("token")
	u.RawQuery = q.Encode()

	baseURL := fmt.Sprintf("%s://%s", u.Scheme, u.Host)
	name := u.Hostname()

	return client.Host{
		Name:  name,
		URL:   baseURL,
		Token: token,
	}, nil
}

