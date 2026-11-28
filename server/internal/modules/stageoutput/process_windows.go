package stageoutput

import (
	"context"
	"os/exec"
	"syscall"

	"golang.org/x/sys/windows"
)

func command(ctx context.Context, path string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, path, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NO_WINDOW}
	return cmd
}
