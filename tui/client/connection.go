// Package client implements the WebSocket client for connecting to remux servers.
// It handles authentication, terminal I/O streaming, and control messages.
package client

import (
	"encoding/json"
	"fmt"
	"net/url"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// Host represents a saved remux server connection.
type Host struct {
	Name  string `json:"name"`
	URL   string `json:"url"`
	Token string `json:"token"`
}

// Session represents a remote terminal session on a host.
type Session struct {
	HostName string
	Name     string
	Attached bool
	Windows  int
}

// ControlMessage is a message sent/received on the control WebSocket.
type ControlMessage struct {
	Type             string           `json:"type"`
	ClientID         string           `json:"clientId,omitempty"`
	RequiresPassword bool             `json:"requiresPassword,omitempty"`
	Session          string           `json:"session,omitempty"`
	Sessions         []SessionSummary `json:"sessions,omitempty"`
	State            *StateSnapshot   `json:"state,omitempty"`
	Reason           string           `json:"reason,omitempty"`
	Message          string           `json:"message,omitempty"`
	PaneID           string           `json:"paneId,omitempty"`
	Text             string           `json:"text,omitempty"`
	Lines            int              `json:"lines,omitempty"`
	Name             string           `json:"name,omitempty"`
}

// SessionSummary matches remux's TmuxSessionSummary.
type SessionSummary struct {
	Name     string `json:"name"`
	Attached bool   `json:"attached"`
	Windows  int    `json:"windows"`
}

// StateSnapshot matches remux's TmuxStateSnapshot.
type StateSnapshot struct {
	Sessions   []SessionState `json:"sessions"`
	CapturedAt string         `json:"capturedAt"`
}

// SessionState matches remux's TmuxSessionState.
type SessionState struct {
	Name         string        `json:"name"`
	Attached     bool          `json:"attached"`
	Windows      int           `json:"windows"`
	WindowStates []WindowState `json:"windowStates"`
}

// WindowState matches remux's TmuxWindowState.
type WindowState struct {
	Index     int         `json:"index"`
	Name      string      `json:"name"`
	Active    bool        `json:"active"`
	PaneCount int         `json:"paneCount"`
	Panes     []PaneState `json:"panes"`
}

// PaneState matches remux's TmuxPaneState.
type PaneState struct {
	Index          int    `json:"index"`
	ID             string `json:"id"`
	CurrentCommand string `json:"currentCommand"`
	Active         bool   `json:"active"`
	Width          int    `json:"width"`
	Height         int    `json:"height"`
	Zoomed         bool   `json:"zoomed"`
}

// Connection manages a WebSocket connection to a single remux server.
type Connection struct {
	host     Host
	password string

	controlConn  *websocket.Conn
	terminalConn *websocket.Conn
	clientID     string

	// Callbacks
	onTerminalData func(data []byte)
	onStateUpdate  func(state *StateSnapshot)
	onSessionList  func(sessions []SessionSummary)
	onAttached     func(session string)
	onError        func(err error)

	mu     sync.Mutex
	closed bool
}

// NewConnection creates a new connection to a remux host.
func NewConnection(host Host, password string) *Connection {
	return &Connection{
		host:     host,
		password: password,
	}
}

// OnTerminalData sets the callback for terminal output data.
func (c *Connection) OnTerminalData(fn func(data []byte)) { c.onTerminalData = fn }

// OnStateUpdate sets the callback for state snapshot updates.
func (c *Connection) OnStateUpdate(fn func(state *StateSnapshot)) { c.onStateUpdate = fn }

// OnSessionList sets the callback for session picker events.
func (c *Connection) OnSessionList(fn func(sessions []SessionSummary)) { c.onSessionList = fn }

// OnAttached sets the callback for successful session attachment.
func (c *Connection) OnAttached(fn func(session string)) { c.onAttached = fn }

// OnError sets the callback for connection errors.
func (c *Connection) OnError(fn func(err error)) { c.onError = fn }

// Connect establishes the control and terminal WebSocket connections.
func (c *Connection) Connect() error {
	controlURL, err := c.buildWSURL("/ws/control")
	if err != nil {
		return fmt.Errorf("build control URL: %w", err)
	}

	dialer := websocket.Dialer{
		HandshakeTimeout: 10 * time.Second,
	}

	c.controlConn, _, err = dialer.Dial(controlURL, nil)
	if err != nil {
		return fmt.Errorf("connect control: %w", err)
	}

	// Authenticate on control channel.
	authMsg := map[string]interface{}{
		"type":  "auth",
		"token": c.host.Token,
	}
	if c.password != "" {
		authMsg["password"] = c.password
	}
	if err := c.controlConn.WriteJSON(authMsg); err != nil {
		return fmt.Errorf("send auth: %w", err)
	}

	// Read auth response.
	var authResp ControlMessage
	if err := c.controlConn.ReadJSON(&authResp); err != nil {
		return fmt.Errorf("read auth response: %w", err)
	}
	if authResp.Type == "auth_error" {
		return fmt.Errorf("auth failed: %s", authResp.Reason)
	}
	if authResp.Type != "auth_ok" {
		return fmt.Errorf("unexpected auth response: %s", authResp.Type)
	}
	c.clientID = authResp.ClientID

	// Connect terminal WebSocket.
	terminalURL, err := c.buildWSURL("/ws/terminal")
	if err != nil {
		return fmt.Errorf("build terminal URL: %w", err)
	}

	c.terminalConn, _, err = dialer.Dial(terminalURL, nil)
	if err != nil {
		return fmt.Errorf("connect terminal: %w", err)
	}

	// Authenticate on terminal channel.
	termAuthMsg := map[string]interface{}{
		"type":     "auth",
		"token":    c.host.Token,
		"clientId": c.clientID,
	}
	if c.password != "" {
		termAuthMsg["password"] = c.password
	}
	if err := c.terminalConn.WriteJSON(termAuthMsg); err != nil {
		return fmt.Errorf("send terminal auth: %w", err)
	}

	// Start read loops.
	go c.readControlLoop()
	go c.readTerminalLoop()

	return nil
}

// SelectSession sends a select_session control message.
func (c *Connection) SelectSession(session string) error {
	return c.sendControl(map[string]interface{}{
		"type":    "select_session",
		"session": session,
	})
}

// SendInput writes raw terminal input to the terminal WebSocket.
func (c *Connection) SendInput(data string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.terminalConn == nil {
		return fmt.Errorf("terminal not connected")
	}
	return c.terminalConn.WriteMessage(websocket.TextMessage, []byte(data))
}

// SendResize sends a resize message to the terminal WebSocket.
func (c *Connection) SendResize(cols, rows int) error {
	msg, _ := json.Marshal(map[string]interface{}{
		"type": "resize",
		"cols": cols,
		"rows": rows,
	})
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.terminalConn == nil {
		return fmt.Errorf("terminal not connected")
	}
	return c.terminalConn.WriteMessage(websocket.TextMessage, msg)
}

// Close disconnects both WebSocket connections.
func (c *Connection) Close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.closed = true
	if c.controlConn != nil {
		c.controlConn.Close()
	}
	if c.terminalConn != nil {
		c.terminalConn.Close()
	}
}

// ClientID returns the assigned client ID.
func (c *Connection) ClientID() string {
	return c.clientID
}

func (c *Connection) sendControl(msg map[string]interface{}) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.controlConn == nil {
		return fmt.Errorf("control not connected")
	}
	return c.controlConn.WriteJSON(msg)
}

func (c *Connection) readControlLoop() {
	for {
		_, raw, err := c.controlConn.ReadMessage()
		if err != nil {
			c.mu.Lock()
			closed := c.closed
			c.mu.Unlock()
			if !closed && c.onError != nil {
				c.onError(fmt.Errorf("control read: %w", err))
			}
			return
		}

		var msg ControlMessage
		if err := json.Unmarshal(raw, &msg); err != nil {
			continue
		}

		switch msg.Type {
		case "tmux_state":
			if c.onStateUpdate != nil && msg.State != nil {
				c.onStateUpdate(msg.State)
			}
		case "session_picker":
			if c.onSessionList != nil {
				c.onSessionList(msg.Sessions)
			}
		case "attached":
			if c.onAttached != nil {
				c.onAttached(msg.Session)
			}
		case "error":
			if c.onError != nil {
				c.onError(fmt.Errorf("server error: %s", msg.Message))
			}
		}
	}
}

func (c *Connection) readTerminalLoop() {
	for {
		msgType, data, err := c.terminalConn.ReadMessage()
		if err != nil {
			c.mu.Lock()
			closed := c.closed
			c.mu.Unlock()
			if !closed && c.onError != nil {
				c.onError(fmt.Errorf("terminal read: %w", err))
			}
			return
		}

		if msgType == websocket.TextMessage || msgType == websocket.BinaryMessage {
			if c.onTerminalData != nil {
				c.onTerminalData(data)
			}
		}
	}
}

func (c *Connection) buildWSURL(path string) (string, error) {
	u, err := url.Parse(c.host.URL)
	if err != nil {
		return "", err
	}

	switch u.Scheme {
	case "https":
		u.Scheme = "wss"
	default:
		u.Scheme = "ws"
	}

	u.Path = path
	q := u.Query()
	q.Set("token", c.host.Token)
	u.RawQuery = q.Encode()

	return u.String(), nil
}

