//go:build !windows

// process_other.go 是类 Unix 平台的子进程窗口处理空实现。

package tts

import "os/exec"

// hideWindow 在非 Windows 平台无需隐藏窗口。
func hideWindow(*exec.Cmd) {}
