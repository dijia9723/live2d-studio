// process_windows.go 为 Windows 子进程隐藏控制台窗口。
package coding

import (
	"os/exec"
	"syscall"
)

// hideWindow 使用 CREATE_NO_WINDOW 标志，避免子进程在桌面端弹出控制台窗口。
func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x08000000}
}
