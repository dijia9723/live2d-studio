//go:build !windows

package stageoutput

import (
	"context"
	"os/exec"
)

func command(ctx context.Context, path string, args ...string) *exec.Cmd {
	return exec.CommandContext(ctx, path, args...)
}
