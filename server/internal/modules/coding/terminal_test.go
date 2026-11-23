//go:build windows || linux || darwin

// terminal_test.go 覆盖交互终端的命令执行、尺寸调整与凭据过滤。
package coding

import (
	"bytes"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func awaitTerminal(t *testing.T, session *terminalSession) (string, int) {
	t.Helper()
	deadline := time.After(15 * time.Second)
	var output bytes.Buffer
	var cursor uint64
	for {
		event, ready := session.next(cursor)
		if ready != nil {
			select {
			case <-ready:
			case <-deadline:
				t.Fatalf("terminal did not finish: %q", output.Bytes())
			}
			continue
		}
		switch event.Type {
		case "reset":
			cursor = event.Cursor
		case "output":
			output.Write(event.Data)
			cursor = event.Cursor
		case "exit":
			return output.String(), *event.Code
		default:
			t.Fatalf("unexpected terminal event: %#v", event)
		}
	}
}

func TestTerminalRunsInteractiveShell(t *testing.T) {
	service := NewTerminalService()
	t.Cleanup(service.Close)
	dir := filepath.Join(t.TempDir(), "project-terminal-fixture")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	session, err := service.start("project-a", dir, terminalSize{Cols: 90, Rows: 30})
	if err != nil {
		t.Fatal(err)
	}
	if service.terminal("project-b", session.id) != nil {
		t.Fatal("terminal could be opened from another project")
	}
	if err := session.device.resize(terminalSize{Cols: 100, Rows: 40}); err != nil {
		t.Fatal(err)
	}
	command := "pwd; printf '%s%s\\n' STUDIO_PTY_ OK; printf '%s%s\\n' 终端 已就绪; exit 7\n"
	if runtime.GOOS == "windows" {
		command = "Write-Output (Get-Location).Path; Write-Output ('STUDIO_PTY_' + 'OK'); Write-Output ('终端' + '已就绪'); exit 7\r"
	}
	session.input <- []byte(command)
	output, code := awaitTerminal(t, session)
	if code != 7 || !strings.Contains(output, "STUDIO_PTY_OK") || !strings.Contains(output, "终端已就绪") || !strings.Contains(output, filepath.Base(dir)) {
		t.Fatalf("did not get expected PTY output (%d): %q", code, output)
	}
}

func TestTerminalClosesShellAndFiltersStudioCredentials(t *testing.T) {
	t.Setenv("STUDIO_TEST_TERMINAL_SECRET", "internal-use-only")
	for _, entry := range terminalEnvironment() {
		if strings.HasPrefix(entry, "STUDIO_TEST_TERMINAL_SECRET=") {
			t.Fatal("Studio environment leaked into terminal")
		}
	}
	service := NewTerminalService()
	first, err := service.start("fixture", t.TempDir(), terminalSize{Cols: 80, Rows: 30})
	if err != nil {
		t.Fatal(err)
	}
	service.Close()
	_, code := awaitTerminal(t, first)
	if code == 0 {
		t.Fatal("terminated shell returned a normal exit")
	}
	if _, err := service.start("fixture", t.TempDir(), terminalSize{Cols: 80, Rows: 30}); err == nil {
		t.Fatal("closed terminal service could start a shell")
	}
}
