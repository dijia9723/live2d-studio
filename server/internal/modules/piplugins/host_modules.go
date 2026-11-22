package piplugins

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"unicode/utf8"
)

// packageModules supplies only small, already-installed JavaScript/JSON modules. The worker
// resolves relative imports against this map and remains blind to the real filesystem.
func packageModules(item Installation) map[string]string {
	const limit = 512 << 10
	exhausted := errors.New("package module collection limit reached")
	root, err := os.OpenRoot(item.Root)
	if err != nil {
		return nil
	}
	defer root.Close()
	modules, remaining, visited := map[string]string{}, int64(limit), 0
	_ = fs.WalkDir(root.FS(), ".", func(name string, entry fs.DirEntry, err error) error {
		if err != nil || name == "." {
			return nil
		}
		visited++
		if remaining < 1 || visited > 4000 || len(modules) >= 192 {
			return exhausted
		}
		if entry.IsDir() && (entry.Name() == "node_modules" || strings.HasPrefix(entry.Name(), ".")) {
			return fs.SkipDir
		}
		if !entry.Type().IsRegular() || name == item.Manifest.Main || name == "manifest.json" ||
			!slices.Contains([]string{".js", ".cjs", ".json"}, extension(name)) {
			return nil
		}
		local, err := packagePath(filepath.ToSlash(name))
		if err != nil {
			return nil
		}
		file, err := root.Open(local)
		if err != nil {
			return nil
		}
		raw, err := readLimited(file, min(remaining, 256<<10))
		file.Close()
		if err == nil && utf8.Valid(raw) {
			modules[name] = string(raw)
			remaining -= int64(len(raw))
		}
		return nil
	})
	return modules
}
