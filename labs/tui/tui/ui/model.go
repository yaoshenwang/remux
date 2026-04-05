// Package tui implements the terminal user interface using bubbletea.
package tui

import (
	"fmt"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/eisber/remux/tui/client"
)

// View mode for the TUI.
type viewMode int

const (
	viewTerminal viewMode = iota
	viewSessionPicker
)

// Model is the bubbletea model for the remux TUI.
type Model struct {
	manager       *client.HostManager
	activeHost    string
	activeSession string
	mode          viewMode
	width, height int

	// Terminal output buffer (raw bytes from the remote PTY).
	terminalOutput strings.Builder

	// Session picker state.
	pickerCursor int

	// Status messages.
	statusMsg string
	errMsg    string

	// Whether we've received terminal data.
	connected bool
}

// terminalDataMsg is sent when terminal output arrives from the server.
type terminalDataMsg struct {
	data []byte
}

// stateUpdateMsg is sent when the session list changes.
type stateUpdateMsg struct{}

// attachedMsg is sent when we've attached to a session.
type attachedMsg struct {
	session string
}

// errMsg is sent on connection errors.
type connectionErrMsg struct {
	err error
}

// NewModel creates a new TUI model.
func NewModel(manager *client.HostManager) Model {
	return Model{
		manager: manager,
		mode:    viewTerminal,
	}
}

// Init implements tea.Model.
func (m Model) Init() tea.Cmd {
	return tea.SetWindowTitle("remux")
}

// Update implements tea.Model.
func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		return m.handleKey(msg)

	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		// Resize the active terminal session.
		if m.activeHost != "" {
			conn := m.manager.GetConnection(m.activeHost)
			if conn != nil {
				_ = conn.SendResize(msg.Width, msg.Height-2) // Reserve 2 lines for status bar
			}
		}
		return m, nil

	case terminalDataMsg:
		m.terminalOutput.Write(msg.data)
		m.connected = true
		return m, nil

	case stateUpdateMsg:
		return m, nil

	case attachedMsg:
		m.activeSession = msg.session
		m.statusMsg = fmt.Sprintf("attached to %s", msg.session)
		m.mode = viewTerminal
		return m, nil

	case connectionErrMsg:
		m.errMsg = msg.err.Error()
		return m, nil
	}

	return m, nil
}

func (m Model) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch m.mode {
	case viewTerminal:
		return m.handleTerminalKey(msg)
	case viewSessionPicker:
		return m.handlePickerKey(msg)
	}
	return m, nil
}

func (m Model) handleTerminalKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "ctrl+o":
		// Open session picker.
		m.mode = viewSessionPicker
		m.pickerCursor = 0
		return m, nil

	case "ctrl+d":
		// Detach — quit the TUI (sessions keep running).
		return m, tea.Quit

	case "ctrl+c":
		return m, tea.Quit

	default:
		// Forward all other input to the active terminal.
		if m.activeHost != "" {
			conn := m.manager.GetConnection(m.activeHost)
			if conn != nil {
				_ = conn.SendInput(msg.String())
			}
		}
		return m, nil
	}
}

func (m Model) handlePickerKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	sessions := m.manager.Sessions()

	switch msg.String() {
	case "up", "k":
		if m.pickerCursor > 0 {
			m.pickerCursor--
		}
	case "down", "j":
		if m.pickerCursor < len(sessions)-1 {
			m.pickerCursor++
		}
	case "enter":
		if m.pickerCursor < len(sessions) {
			selected := sessions[m.pickerCursor]
			m.activeHost = selected.HostName
			conn := m.manager.GetConnection(selected.HostName)
			if conn != nil {
				_ = conn.SelectSession(selected.Name)
			}
			m.mode = viewTerminal
			m.terminalOutput.Reset()
			m.statusMsg = fmt.Sprintf("switching to %s/%s...", selected.HostName, selected.Name)
		}
	case "escape", "ctrl+o":
		m.mode = viewTerminal
	case "ctrl+c", "ctrl+d":
		return m, tea.Quit
	}
	return m, nil
}

// View implements tea.Model.
func (m Model) View() string {
	if m.width == 0 {
		return "initializing..."
	}

	switch m.mode {
	case viewSessionPicker:
		return m.renderPicker()
	default:
		return m.renderTerminal()
	}
}

func (m Model) renderTerminal() string {
	// Terminal content fills the screen minus the status bar.
	contentHeight := m.height - 2
	if contentHeight < 1 {
		contentHeight = 1
	}

	// Get terminal output and take the last N lines.
	output := m.terminalOutput.String()
	lines := strings.Split(output, "\n")
	if len(lines) > contentHeight {
		lines = lines[len(lines)-contentHeight:]
	}
	content := strings.Join(lines, "\n")

	// Status bar.
	statusStyle := lipgloss.NewStyle().
		Background(lipgloss.Color("236")).
		Foreground(lipgloss.Color("252")).
		Width(m.width).
		Padding(0, 1)

	var statusLeft string
	if m.activeHost != "" && m.activeSession != "" {
		statusLeft = fmt.Sprintf("⬤ %s/%s", m.activeHost, m.activeSession)
	} else if m.errMsg != "" {
		statusLeft = fmt.Sprintf("✗ %s", m.errMsg)
	} else {
		statusLeft = m.statusMsg
	}
	statusRight := "Ctrl-O: sessions │ Ctrl-D: detach"

	padding := m.width - lipgloss.Width(statusLeft) - lipgloss.Width(statusRight) - 2
	if padding < 1 {
		padding = 1
	}
	statusBar := statusStyle.Render(statusLeft + strings.Repeat(" ", padding) + statusRight)

	return content + "\n" + statusBar
}

func (m Model) renderPicker() string {
	sessions := m.manager.Sessions()

	titleStyle := lipgloss.NewStyle().
		Bold(true).
		Foreground(lipgloss.Color("212")).
		Padding(1, 2)

	itemStyle := lipgloss.NewStyle().Padding(0, 2)
	selectedStyle := itemStyle.Background(lipgloss.Color("236")).Foreground(lipgloss.Color("212"))

	var b strings.Builder
	b.WriteString(titleStyle.Render("Sessions (↑/↓ select, Enter attach, Esc cancel)"))
	b.WriteString("\n\n")

	if len(sessions) == 0 {
		b.WriteString(itemStyle.Render("  No sessions available"))
		return b.String()
	}

	currentHost := ""
	for i, s := range sessions {
		// Group header for host.
		if s.HostName != currentHost {
			currentHost = s.HostName
			headerStyle := lipgloss.NewStyle().
				Bold(true).
				Foreground(lipgloss.Color("245")).
				Padding(0, 2)
			b.WriteString(headerStyle.Render(fmt.Sprintf("── %s ──", currentHost)))
			b.WriteString("\n")
		}

		prefix := "  "
		style := itemStyle
		if i == m.pickerCursor {
			prefix = "▸ "
			style = selectedStyle
		}

		attached := ""
		if s.Attached {
			attached = " (attached)"
		}

		line := fmt.Sprintf("%s%s%s", prefix, s.Name, attached)
		b.WriteString(style.Render(line))
		b.WriteString("\n")
	}

	return b.String()
}

// SetupCallbacks wires the HostManager callbacks to bubbletea messages.
func SetupCallbacks(manager *client.HostManager, p *tea.Program) {
	manager.OnChange(func() {
		p.Send(stateUpdateMsg{})
	})
}

// SetupConnectionCallbacks wires a Connection's callbacks to bubbletea messages.
func SetupConnectionCallbacks(conn *client.Connection, p *tea.Program) {
	conn.OnTerminalData(func(data []byte) {
		p.Send(terminalDataMsg{data: data})
	})
	conn.OnAttached(func(session string) {
		p.Send(attachedMsg{session: session})
	})
	conn.OnError(func(err error) {
		p.Send(connectionErrMsg{err: err})
	})
}

