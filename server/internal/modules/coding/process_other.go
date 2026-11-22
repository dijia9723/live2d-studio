//go:build !windows

package coding

import "os/exec"

func hideWindow(_ *exec.Cmd) {}
