//go:build headless

package app

import (
	"fmt"
	"server/internal/bootstrap"
)

func runDesktop(_ *bootstrap.App, _ string) error {
	return fmt.Errorf("此程序使用 headless 构建，请加上 -headless 参数")
}
