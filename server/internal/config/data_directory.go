package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// DataDirEditable reports whether startup allows storing a directory preference.
func (cfg Config) DataDirEditable() bool {
	return cfg.dataDirPreference != "" && !cfg.dataDirFromEnv
}

func (cfg Config) DataDirFromEnv() bool {
	return cfg.dataDirFromEnv
}

// PreferredDataDir reads the UI preference separately from the active database and YAML.
// An empty result means startup uses the YAML, built-in default, or environment override.
func (cfg Config) PreferredDataDir() (string, error) {
	if !cfg.DataDirEditable() {
		return "", nil
	}
	data, err := os.ReadFile(cfg.dataDirPreference)
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("读取数据目录设置: %w", err)
	}
	var dir string
	if err := json.Unmarshal(data, &dir); err != nil || !filepath.IsAbs(dir) {
		return "", fmt.Errorf("数据目录设置无效 (%s)", cfg.dataDirPreference)
	}
	return filepath.Clean(dir), nil
}

// SaveDataDir writes only the startup preference. The running services keep their current paths.
func (cfg Config) SaveDataDir(dir string) error {
	if !cfg.DataDirEditable() {
		return errors.New("当前启动配置无法更改数据目录")
	}
	if !filepath.IsAbs(dir) {
		return errors.New("请选择绝对目录路径")
	}
	probe, err := os.CreateTemp(dir, ".studio-write-check-*")
	if err != nil {
		return fmt.Errorf("无法写入所选目录: %w", err)
	}
	if err := errors.Join(probe.Close(), os.Remove(probe.Name())); err != nil {
		return fmt.Errorf("无法完成目录写入检查: %w", err)
	}

	parent := filepath.Dir(cfg.dataDirPreference)
	if err := os.MkdirAll(parent, 0700); err != nil {
		return fmt.Errorf("创建配置目录: %w", err)
	}
	file, err := os.CreateTemp(parent, ".studio-data-dir-*")
	if err != nil {
		return fmt.Errorf("保存数据目录设置: %w", err)
	}
	defer os.Remove(file.Name())
	err = json.NewEncoder(file).Encode(filepath.Clean(dir))
	if err := errors.Join(err, file.Close()); err != nil {
		return fmt.Errorf("保存数据目录设置: %w", err)
	}
	if err := os.Rename(file.Name(), cfg.dataDirPreference); err != nil {
		return fmt.Errorf("保存数据目录设置: %w", err)
	}
	return nil
}
