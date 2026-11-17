package app

import (
	"fmt"
	"os"
	"path/filepath"
)

func resolveConfigPath(explicit string) (string, error) {
	executable, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("读取程序位置: %w", err)
	}
	workingDir, err := os.Getwd()
	if err != nil {
		return "", fmt.Errorf("读取工作目录: %w", err)
	}
	return configPathFor(explicit, executable, workingDir, func(dir string) bool {
		info, err := os.Stat(dir)
		return err == nil && info.IsDir()
	}), nil
}

// configPathFor gives a packaged executable its own stable config/data root.
// Wails development builds place the executable under .wails/dev, so development
// still falls back to the server/ source directory. All paths are absolute;
// callers can inject both process locations and the directory lookup.
func configPathFor(explicit, executable, workingDir string, directoryExists func(string) bool) string {
	if explicit != "" {
		if filepath.IsAbs(explicit) {
			return filepath.Clean(explicit)
		}
		return filepath.Join(workingDir, explicit)
	}
	packaged := filepath.Join(filepath.Dir(executable), "configs", "config.yaml")
	for _, candidate := range []string{
		packaged,
		filepath.Join(workingDir, "configs", "config.yaml"),
		filepath.Join(workingDir, "server", "configs", "config.yaml"),
	} {
		if directoryExists(filepath.Dir(candidate)) {
			return candidate
		}
	}
	return packaged
}
