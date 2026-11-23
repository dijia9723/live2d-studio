// process_windows.go 负责在 Windows 上隐藏 Python 子进程的控制台窗口。

package tts

import (
	"os/exec"
	"syscall"
)

// hideWindow 给子进程加上 CREATE_NO_WINDOW 标志，避免合成时弹出黑色窗口。
func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x08000000} // CREATE_NO_WINDOW
}
