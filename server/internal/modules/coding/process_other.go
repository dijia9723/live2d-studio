//go:build !windows

// process_other.go 在非 Windows 平台提供空实现的隐藏窗口函数。
package coding

import "os/exec"

func hideWindow(_ *exec.Cmd) {}
