// Package client implements multi-host connection management.
package client

import (
	"fmt"
	"sync"
)

// HostManager manages connections to multiple remux hosts and provides
// a unified view of all sessions across hosts.
type HostManager struct {
	mu          sync.RWMutex
	connections map[string]*Connection // keyed by host name
	hosts       []Host
	sessions    []Session // aggregated from all hosts
	onChange    func()    // called when session list changes
}

// NewHostManager creates a new multi-host manager.
func NewHostManager() *HostManager {
	return &HostManager{
		connections: make(map[string]*Connection),
	}
}

// OnChange sets a callback invoked when the aggregated session list changes.
func (m *HostManager) OnChange(fn func()) {
	m.onChange = fn
}

// AddHost connects to a remux host and starts tracking its sessions.
func (m *HostManager) AddHost(host Host, password string) error {
	conn := NewConnection(host, password)

	conn.OnStateUpdate(func(state *StateSnapshot) {
		m.mu.Lock()
		m.updateSessionsFromState(host.Name, state)
		m.mu.Unlock()
		if m.onChange != nil {
			m.onChange()
		}
	})

	conn.OnSessionList(func(sessions []SessionSummary) {
		m.mu.Lock()
		m.updateSessionsFromList(host.Name, sessions)
		m.mu.Unlock()
		if m.onChange != nil {
			m.onChange()
		}
	})

	if err := conn.Connect(); err != nil {
		return fmt.Errorf("connect to %s: %w", host.Name, err)
	}

	m.mu.Lock()
	m.connections[host.Name] = conn
	m.hosts = append(m.hosts, host)
	m.mu.Unlock()

	return nil
}

// GetConnection returns the connection for a host.
func (m *HostManager) GetConnection(hostName string) *Connection {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.connections[hostName]
}

// Sessions returns the current aggregated session list.
func (m *HostManager) Sessions() []Session {
	m.mu.RLock()
	defer m.mu.RUnlock()
	result := make([]Session, len(m.sessions))
	copy(result, m.sessions)
	return result
}

// Hosts returns the list of connected hosts.
func (m *HostManager) Hosts() []Host {
	m.mu.RLock()
	defer m.mu.RUnlock()
	result := make([]Host, len(m.hosts))
	copy(result, m.hosts)
	return result
}

// Close disconnects from all hosts.
func (m *HostManager) Close() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, conn := range m.connections {
		conn.Close()
	}
	m.connections = make(map[string]*Connection)
}

func (m *HostManager) updateSessionsFromState(hostName string, state *StateSnapshot) {
	// Remove old sessions for this host.
	filtered := m.sessions[:0]
	for _, s := range m.sessions {
		if s.HostName != hostName {
			filtered = append(filtered, s)
		}
	}

	// Add new sessions from state.
	for _, ss := range state.Sessions {
		filtered = append(filtered, Session{
			HostName: hostName,
			Name:     ss.Name,
			Attached: ss.Attached,
			Windows:  ss.Windows,
		})
	}

	m.sessions = filtered
}

func (m *HostManager) updateSessionsFromList(hostName string, sessions []SessionSummary) {
	filtered := m.sessions[:0]
	for _, s := range m.sessions {
		if s.HostName != hostName {
			filtered = append(filtered, s)
		}
	}

	for _, ss := range sessions {
		filtered = append(filtered, Session{
			HostName: hostName,
			Name:     ss.Name,
			Attached: ss.Attached,
			Windows:  ss.Windows,
		})
	}

	m.sessions = filtered
}

