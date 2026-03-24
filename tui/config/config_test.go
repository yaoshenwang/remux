package config

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/eisber/remux/tui/client"
)

func TestLoadNonExistent(t *testing.T) {
	cfg, err := Load(filepath.Join(t.TempDir(), "nonexistent.json"))
	if err != nil {
		t.Fatalf("expected nil error for missing file, got: %v", err)
	}
	if len(cfg.Hosts) != 0 {
		t.Fatalf("expected 0 hosts, got: %d", len(cfg.Hosts))
	}
}

func TestSaveAndLoad(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config", "hosts.json")

	cfg := &ConfigFile{
		Hosts: []client.Host{
			{Name: "devbox", URL: "http://localhost:8767", Token: "abc123"},
			{Name: "cloud", URL: "https://my.devtunnels.ms", Token: "xyz"},
		},
	}

	if err := Save(path, cfg); err != nil {
		t.Fatalf("save failed: %v", err)
	}

	loaded, err := Load(path)
	if err != nil {
		t.Fatalf("load failed: %v", err)
	}

	if len(loaded.Hosts) != 2 {
		t.Fatalf("expected 2 hosts, got: %d", len(loaded.Hosts))
	}
	if loaded.Hosts[0].Name != "devbox" {
		t.Fatalf("expected host name 'devbox', got: %s", loaded.Hosts[0].Name)
	}
	if loaded.Hosts[1].Token != "xyz" {
		t.Fatalf("expected token 'xyz', got: %s", loaded.Hosts[1].Token)
	}
}

func TestSaveCreatesDirectories(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "deep", "nested", "hosts.json")

	cfg := &ConfigFile{Hosts: []client.Host{{Name: "test", URL: "http://localhost", Token: "t"}}}
	if err := Save(path, cfg); err != nil {
		t.Fatalf("save failed: %v", err)
	}

	if _, err := os.Stat(path); os.IsNotExist(err) {
		t.Fatal("config file was not created")
	}
}

func TestSaveFilePermissions(t *testing.T) {
	if os.Getenv("OS") == "Windows_NT" {
		t.Skip("file permissions test not reliable on Windows")
	}

	dir := t.TempDir()
	path := filepath.Join(dir, "hosts.json")

	cfg := &ConfigFile{Hosts: []client.Host{{Name: "test", URL: "http://localhost", Token: "secret"}}}
	if err := Save(path, cfg); err != nil {
		t.Fatalf("save failed: %v", err)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat failed: %v", err)
	}

	perm := info.Mode().Perm()
	if perm&0077 != 0 {
		t.Fatalf("config file should not be world/group readable, got: %o", perm)
	}
}

