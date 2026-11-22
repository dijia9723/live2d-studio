//go:build !windows && !linux && !darwin

package coding

import "errors"

func openPseudoTerminal(string, terminalSize) (pseudoTerminal, error) {
	return nil, errors.New("此平台不支持交互终端")
}
