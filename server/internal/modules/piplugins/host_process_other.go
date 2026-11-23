//go:build !windows

// host_process_other.go 在非 Windows 平台提供空的子进程配置与限制实现。
package piplugins

import "os/exec"

func setupHostedProcess(_ *exec.Cmd) {}

func limitHostedProcess(_ *exec.Cmd) (func(), error) {
	return func() {}, nil
}
