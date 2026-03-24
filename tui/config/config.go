// Package config handles loading and saving host configurations.
package config

import (
	"encoding/json"
	"os"
	"path/filepath"

	"github.com/eisber/remux/tui/client"
)

// ConfigFile is the structure stored in ~/.remux/hosts.json.
type ConfigFile struct {
	Hosts []client.Host `json:"hosts"`
}

// DefaultConfigPath returns the default config file location.
func DefaultConfigPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".remux", "hosts.json")
}

// Load reads hosts from the config file.
func Load(path string) (*ConfigFile, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return &ConfigFile{}, nil
		}
		return nil, err
	}

	var cfg ConfigFile
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, err
	}
	return &cfg, nil
}

// Save writes hosts to the config file.
func Save(path string, cfg *ConfigFile) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}

	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0600)
}

