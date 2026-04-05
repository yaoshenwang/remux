package client

import (
	"net/url"
	"testing"
)

func TestConnectionBuildWSURL(t *testing.T) {
	tests := []struct {
		name     string
		host     Host
		path     string
		wantScheme string
	}{
		{
			name:       "http becomes ws",
			host:       Host{URL: "http://localhost:8767", Token: "abc"},
			path:       "/ws/control",
			wantScheme: "ws",
		},
		{
			name:       "https becomes wss",
			host:       Host{URL: "https://my.devtunnels.ms", Token: "xyz"},
			path:       "/ws/terminal",
			wantScheme: "wss",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			conn := NewConnection(tt.host, "")
			wsURL, err := conn.buildWSURL(tt.path)
			if err != nil {
				t.Fatalf("buildWSURL failed: %v", err)
			}

			parsed, err := url.Parse(wsURL)
			if err != nil {
				t.Fatalf("parse URL failed: %v", err)
			}

			if parsed.Scheme != tt.wantScheme {
				t.Errorf("scheme = %q, want %q", parsed.Scheme, tt.wantScheme)
			}
			if parsed.Path != tt.path {
				t.Errorf("path = %q, want %q", parsed.Path, tt.path)
			}
			if parsed.Query().Get("token") != tt.host.Token {
				t.Errorf("token = %q, want %q", parsed.Query().Get("token"), tt.host.Token)
			}
		})
	}
}

func TestHostManagerSessions(t *testing.T) {
	manager := NewHostManager()

	// Simulate state updates from two hosts.
	manager.mu.Lock()
	manager.updateSessionsFromState("host-a", &StateSnapshot{
		Sessions: []SessionState{
			{Name: "session-1", Attached: true, Windows: 1},
			{Name: "session-2", Attached: false, Windows: 2},
		},
	})
	manager.updateSessionsFromState("host-b", &StateSnapshot{
		Sessions: []SessionState{
			{Name: "session-3", Attached: false, Windows: 1},
		},
	})
	manager.mu.Unlock()

	sessions := manager.Sessions()
	if len(sessions) != 3 {
		t.Fatalf("expected 3 sessions, got %d", len(sessions))
	}

	// Verify sessions are from the right hosts.
	hostCounts := map[string]int{}
	for _, s := range sessions {
		hostCounts[s.HostName]++
	}
	if hostCounts["host-a"] != 2 {
		t.Errorf("expected 2 sessions from host-a, got %d", hostCounts["host-a"])
	}
	if hostCounts["host-b"] != 1 {
		t.Errorf("expected 1 session from host-b, got %d", hostCounts["host-b"])
	}
}

func TestHostManagerStateUpdateReplacesOldSessions(t *testing.T) {
	manager := NewHostManager()

	// First update.
	manager.mu.Lock()
	manager.updateSessionsFromState("host-a", &StateSnapshot{
		Sessions: []SessionState{
			{Name: "old-session", Attached: false, Windows: 1},
		},
	})
	manager.mu.Unlock()

	if len(manager.Sessions()) != 1 {
		t.Fatalf("expected 1 session after first update")
	}

	// Second update replaces the first.
	manager.mu.Lock()
	manager.updateSessionsFromState("host-a", &StateSnapshot{
		Sessions: []SessionState{
			{Name: "new-session-1", Attached: true, Windows: 1},
			{Name: "new-session-2", Attached: false, Windows: 1},
		},
	})
	manager.mu.Unlock()

	sessions := manager.Sessions()
	if len(sessions) != 2 {
		t.Fatalf("expected 2 sessions after replacement, got %d", len(sessions))
	}
	if sessions[0].Name != "new-session-1" {
		t.Errorf("expected first session 'new-session-1', got %q", sessions[0].Name)
	}
}

