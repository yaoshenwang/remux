// Package tests contains integration tests that connect to a real remux server.
//
// These tests require:
// - Node.js (for running the remux server)
// - The remux repo built at ../remux (adjacent to this repo)
//
// Run with: go test -tags=integration ./tests/ -v
package tests

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/eisber/remux/tui/client"
)

func findFreePort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	port := l.Addr().(*net.TCPAddr).Port
	l.Close()
	return port, nil
}

func findRemuxDir() string {
	// Look for the remux repo relative to this test file.
	candidates := []string{
		filepath.Join("..", "..", "remux"),         // C:\work\remux from C:\work\remux-tui\tests
		filepath.Join("..", "..", "..", "remux"),
	}
	for _, c := range candidates {
		abs, _ := filepath.Abs(c)
		if _, err := os.Stat(filepath.Join(abs, "package.json")); err == nil {
			return abs
		}
	}
	return ""
}

// startRemuxServer builds and starts a remux server on a free port.
// Returns the port, token, password, and a cleanup function.
func startRemuxServer(t *testing.T) (port int, token, password string, cleanup func()) {
	t.Helper()

	remuxDir := findRemuxDir()
	if remuxDir == "" {
		t.Skip("remux repo not found at ../remux — skipping integration test")
	}

	// Check if remux is built.
	distCli := filepath.Join(remuxDir, "dist", "backend", "cli.js")
	if _, err := os.Stat(distCli); os.IsNotExist(err) {
		// Try to build it.
		t.Log("building remux...")
		buildCmd := exec.Command("npm", "run", "build")
		buildCmd.Dir = remuxDir
		if out, err := buildCmd.CombinedOutput(); err != nil {
			t.Skipf("failed to build remux: %s\n%s", err, out)
		}
	}

	port, err := findFreePort()
	if err != nil {
		t.Fatalf("find free port: %v", err)
	}

	// Start remux server with no tunnel, explicit password.
	password = "test-password-123"
	cmd := exec.Command("node", distCli,
		"--port", fmt.Sprintf("%d", port),
		"--password", password,
		"--no-tunnel",
		"--session", "test-session",
	)
	cmd.Dir = remuxDir
	cmd.Env = append(os.Environ(), "VITE_DEV_MODE=1")

	// Capture stdout to extract token.
	stdout := &strings.Builder{}
	cmd.Stdout = stdout
	cmd.Stderr = stdout

	if err := cmd.Start(); err != nil {
		t.Fatalf("start remux: %v", err)
	}

	// Wait for server to be ready.
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		resp, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/api/config", port))
		if err == nil {
			resp.Body.Close()
			break
		}
		time.Sleep(200 * time.Millisecond)
	}

	// Extract token from /api/config.
	resp, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/api/config", port))
	if err != nil {
		cmd.Process.Kill()
		t.Fatalf("server not ready: %v\nOutput: %s", err, stdout.String())
	}
	defer resp.Body.Close()

	var configResp struct {
		Token string `json:"token"`
	}

	// The token is in the URL printed by the server, or we can get it from
	// the server output. For a cleaner approach, let's parse the stdout.
	output := stdout.String()

	// Token is in the URL as ?token=<value>
	for _, line := range strings.Split(output, "\n") {
		if idx := strings.Index(line, "token="); idx >= 0 {
			tokenPart := line[idx+6:]
			// Token ends at & or end of line or space
			end := len(tokenPart)
			for i, c := range tokenPart {
				if c == '&' || c == ' ' || c == '\n' || c == '\r' {
					end = i
					break
				}
			}
			configResp.Token = tokenPart[:end]
			break
		}
	}

	if configResp.Token == "" {
		// Fall back: try connecting without token to see error.
		cmd.Process.Kill()
		t.Fatalf("could not extract token from server output:\n%s", output)
	}

	token = configResp.Token
	t.Logf("remux server started on port %d (token=%s...)", port, token[:8])

	cleanup = func() {
		if runtime.GOOS == "windows" {
			exec.Command("taskkill", "/pid", fmt.Sprintf("%d", cmd.Process.Pid), "/t", "/f").Run()
		} else {
			cmd.Process.Kill()
		}
		cmd.Wait()
	}

	return port, token, password, cleanup
}

func TestIntegrationConnectToRemux(t *testing.T) {
	if os.Getenv("REMUX_INTEGRATION") != "1" {
		t.Skip("set REMUX_INTEGRATION=1 to run integration tests")
	}

	port, token, password, cleanup := startRemuxServer(t)
	defer cleanup()

	// Test 1: Connect via our client library.
	host := client.Host{
		Name:  "test",
		URL:   fmt.Sprintf("http://127.0.0.1:%d", port),
		Token: token,
	}

	conn := client.NewConnection(host, password)

	var gotTerminalData bool
	doneCh := make(chan struct{}, 2)

	conn.OnTerminalData(func(data []byte) {
		if !gotTerminalData {
			gotTerminalData = true
			t.Logf("received terminal data: %d bytes", len(data))
			doneCh <- struct{}{}
		}
	})

	conn.OnStateUpdate(func(state *client.StateSnapshot) {
		t.Logf("received state: %d sessions", len(state.Sessions))
		doneCh <- struct{}{}
	})

	conn.OnError(func(err error) {
		t.Logf("connection error: %v", err)
	})

	if err := conn.Connect(); err != nil {
		t.Fatalf("connect failed: %v", err)
	}
	defer conn.Close()

	// Wait for either terminal data or state update.
	select {
	case <-doneCh:
		t.Log("received first message from server")
	case <-time.After(10 * time.Second):
		t.Fatal("timeout waiting for server messages")
	}

	// Test 2: Send input and verify it doesn't error.
	if err := conn.SendInput("echo hello\r"); err != nil {
		t.Fatalf("send input failed: %v", err)
	}

	// Test 3: Send resize.
	if err := conn.SendResize(120, 40); err != nil {
		t.Fatalf("send resize failed: %v", err)
	}

	t.Log("integration test passed")
}

func TestIntegrationRawWebSocket(t *testing.T) {
	if os.Getenv("REMUX_INTEGRATION") != "1" {
		t.Skip("set REMUX_INTEGRATION=1 to run integration tests")
	}

	port, token, password, cleanup := startRemuxServer(t)
	defer cleanup()

	// Test raw WebSocket protocol directly.
	controlURL := fmt.Sprintf("ws://127.0.0.1:%d/ws/control", port)
	controlConn, _, err := websocket.DefaultDialer.Dial(controlURL, nil)
	if err != nil {
		t.Fatalf("dial control: %v", err)
	}
	defer controlConn.Close()

	// Send auth.
	authMsg := map[string]interface{}{
		"type":     "auth",
		"token":    token,
		"password": password,
	}
	if err := controlConn.WriteJSON(authMsg); err != nil {
		t.Fatalf("send auth: %v", err)
	}

	// Read auth response.
	_, raw, err := controlConn.ReadMessage()
	if err != nil {
		t.Fatalf("read auth response: %v", err)
	}

	var resp map[string]interface{}
	json.Unmarshal(raw, &resp)

	if resp["type"] != "auth_ok" {
		t.Fatalf("expected auth_ok, got: %v", resp)
	}

	clientID, ok := resp["clientId"].(string)
	if !ok || clientID == "" {
		t.Fatal("missing clientId in auth_ok")
	}

	t.Logf("authenticated with clientId=%s", clientID)

	// Read a few more messages to see state/session_picker.
	for i := 0; i < 5; i++ {
		controlConn.SetReadDeadline(time.Now().Add(5 * time.Second))
		_, raw, err := controlConn.ReadMessage()
		if err != nil {
			break
		}
		json.Unmarshal(raw, &resp)
		t.Logf("received: type=%v", resp["type"])
	}
}

