//go:build !windows && !linux && !darwin

// terminal_unsupported.go 在不支持的平台返回终端不可用错误。
package coding

import "errors"

func openPseudoTerminal(string, terminalSize) (pseudoTerminal, error) {
	return nil, errors.New("此平台不支持交互终端")
}
