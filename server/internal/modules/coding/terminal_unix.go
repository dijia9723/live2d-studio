//go:build linux || darwin

// terminal_unix.go 基于伪终端实现 Linux 与 macOS 的交互终端。
package coding

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/creack/pty"
	"golang.org/x/sys/unix"
)

type unixTerminal struct {
	*os.File
	cmd *exec.Cmd
}

func openPseudoTerminal(directory string, size terminalSize) (pseudoTerminal, error) {
	shell := os.Getenv("SHELL")
	if !filepath.IsAbs(shell) {
		shell = "/bin/sh"
	}
	cmd := exec.Command(shell, "-i")
	cmd.Dir = directory
	cmd.Env = terminalEnvironment()
	for i, entry := range cmd.Env {
		if strings.HasPrefix(entry, "PWD=") {
			cmd.Env[i] = "PWD=" + directory
			break
		}
	}
	device, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: uint16(size.Rows), Cols: uint16(size.Cols)})
	if err != nil {
		return nil, err
	}
	// Go 的 poller 需要非阻塞的 master，这样即使子进程仍持有 slave，Close 也能唤醒阻塞中的读取。
	fd, err := unix.Dup(int(device.Fd()))
	_ = device.Close()
	if err == nil {
		unix.CloseOnExec(fd)
		err = unix.SetNonblock(fd, true)
		if err == nil {
			return &unixTerminal{File: os.NewFile(uintptr(fd), "studio-terminal"), cmd: cmd}, nil
		}
		_ = unix.Close(fd)
	}
	_ = cmd.Process.Kill()
	_ = cmd.Wait()
	return nil, err
}

func (t *unixTerminal) resize(size terminalSize) error {
	return pty.Setsize(t.File, &pty.Winsize{Rows: uint16(size.Rows), Cols: uint16(size.Cols)})
}

func (t *unixTerminal) stop() {
	_ = syscall.Kill(-t.cmd.Process.Pid, syscall.SIGKILL)
}

func (t *unixTerminal) wait() int {
	_ = t.cmd.Wait()
	return t.cmd.ProcessState.ExitCode()
}
