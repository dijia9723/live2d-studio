//go:build !windows

package piplugins

import "os/exec"

func setupHostedProcess(_ *exec.Cmd) {}

func limitHostedProcess(_ *exec.Cmd) (func(), error) {
	return func() {}, nil
}
