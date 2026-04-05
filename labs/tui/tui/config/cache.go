package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

// ScrollbackCache caches terminal scrollback per session for instant
// re-scroll and offline viewing. Stored in ~/.remux/cache/<host>/<session>.json.
type ScrollbackCache struct {
	mu       sync.Mutex
	cacheDir string
}

// CachedSession is the on-disk format for cached session data.
type CachedSession struct {
	Lines   []string `json:"lines"`
	LastSeq int      `json:"lastSeq"`
	Cursor  [2]int   `json:"cursor"`
	Cols    int      `json:"cols"`
	Rows    int      `json:"rows"`
}

// NewScrollbackCache creates a cache rooted at ~/.remux/cache/.
func NewScrollbackCache() *ScrollbackCache {
	home, _ := os.UserHomeDir()
	return &ScrollbackCache{
		cacheDir: filepath.Join(home, ".remux", "cache"),
	}
}

// Save writes cached session data to disk.
func (c *ScrollbackCache) Save(hostName, sessionName string, data *CachedSession) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	dir := filepath.Join(c.cacheDir, sanitize(hostName))
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}

	bytes, err := json.Marshal(data)
	if err != nil {
		return err
	}

	return os.WriteFile(filepath.Join(dir, sanitize(sessionName)+".json"), bytes, 0600)
}

// Load reads cached session data from disk.
func (c *ScrollbackCache) Load(hostName, sessionName string) (*CachedSession, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	path := filepath.Join(c.cacheDir, sanitize(hostName), sanitize(sessionName)+".json")
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	var cached CachedSession
	if err := json.Unmarshal(data, &cached); err != nil {
		return nil, err
	}

	return &cached, nil
}

func sanitize(s string) string {
	result := make([]byte, 0, len(s))
	for _, c := range []byte(s) {
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' {
			result = append(result, c)
		} else {
			result = append(result, '_')
		}
	}
	return string(result)
}
