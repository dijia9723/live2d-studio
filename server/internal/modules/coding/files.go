// files.go 负责项目内文本文件的列举、读取、带版本校验的写入与路径安全校验。
package coding

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
)

const maxFileSize = 256 << 10

var errStaleFile = errors.New("文件内容已变更，请重新读取后再保存")

type fileEntry struct {
	Name string `json:"name"`
	Dir  bool   `json:"dir"`
}

type fileContent struct {
	Content  string `json:"content"`
	Revision string `json:"revision"`
}

func ignoredName(name string) bool {
	name = strings.ToLower(name)
	return name == ".git" || name == "node_modules" || name == ".venv" || name == ".env" || strings.HasPrefix(name, ".env.") && name != ".env.example"
}

// localPath 把请求路径转换为项目内相对路径，拒绝绝对路径、盘符、符号链接与受保护文件名，防止路径穿越。
func localPath(path string, allowRoot bool) (string, error) {
	if (path == "" || path == ".") && allowRoot {
		return ".", nil
	}
	local, err := filepath.Localize(path)
	if err != nil || path == "." || strings.ContainsAny(path, `\:`) {
		return "", errors.New("请选择项目内的相对路径")
	}
	for _, part := range strings.Split(path, "/") {
		if ignoredName(strings.TrimRight(part, " .")) || strings.HasPrefix(part, ".studio-pi-") {
			return "", errors.New("此路径超出编码工作台的文件范围")
		}
	}
	return local, nil
}

func listFiles(root *os.Root, path string) ([]fileEntry, error) {
	local, err := localPath(path, true)
	if err != nil {
		return nil, err
	}
	if err := checkFilePath(root, local); err != nil {
		return nil, err
	}
	entries, err := fs.ReadDir(root.FS(), filepath.ToSlash(local))
	if err != nil {
		return nil, errors.New("无法读取项目目录")
	}
	files := make([]fileEntry, 0, min(len(entries), 400))
	for _, entry := range entries {
		if len(files) == 400 {
			break
		}
		if ignoredName(entry.Name()) || strings.HasPrefix(entry.Name(), ".studio-pi-") || !entry.IsDir() && !entry.Type().IsRegular() {
			continue
		}
		files = append(files, fileEntry{Name: entry.Name(), Dir: entry.IsDir()})
	}
	return files, nil
}

func readLocalFile(root *os.Root, local string) (fileContent, error) {
	info, err := root.Stat(local)
	if err != nil {
		return fileContent{}, err
	}
	if !info.Mode().IsRegular() || info.Size() > maxFileSize {
		return fileContent{}, errors.New("仅支持不超过 256 KiB 的普通文本文件")
	}
	file, err := root.Open(local)
	if err != nil {
		return fileContent{}, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxFileSize+1))
	if err != nil {
		return fileContent{}, err
	}
	if len(data) > maxFileSize || !utf8.Valid(data) || strings.IndexByte(string(data), 0) >= 0 {
		return fileContent{}, errors.New("仅支持不超过 256 KiB 的 UTF-8 文本文件")
	}
	return fileContent{Content: string(data), Revision: fmt.Sprintf("%x", sha256.Sum256(data))}, nil
}

func readFile(root *os.Root, path string) (fileContent, error) {
	local, err := localPath(path, false)
	if err != nil {
		return fileContent{}, err
	}
	if err := checkFilePath(root, local); err != nil {
		return fileContent{}, err
	}
	return readLocalFile(root, local)
}

// checkFilePath 逐级检查路径上的符号链接，避免经由链接逃逸出项目根目录。
func checkFilePath(root *os.Root, local string) error {
	for path := local; path != "."; path = filepath.Dir(path) {
		info, err := root.Lstat(path)
		if err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
		if err == nil && info.Mode()&os.ModeSymlink != 0 {
			return errors.New("编码工作台跳过符号链接")
		}
	}
	return nil
}

// writeFile 先校验乐观版本号，再写入同目录临时文件并原子改名，保证读取方只会看到完整版本。
func (m *Module) writeFile(root *os.Root, path string, content fileContent) (fileContent, error) {
	local, err := localPath(path, false)
	if err != nil {
		return fileContent{}, err
	}
	if len(content.Content) > maxFileSize || !utf8.ValidString(content.Content) || strings.IndexByte(content.Content, 0) >= 0 {
		return fileContent{}, errors.New("仅支持不超过 256 KiB 的 UTF-8 文本文件")
	}
	m.filesMu.Lock()
	defer m.filesMu.Unlock()
	if err := checkFilePath(root, local); err != nil {
		return fileContent{}, err
	}
	mode := fs.FileMode(0644)
	info, err := root.Lstat(local)
	if err == nil {
		if !info.Mode().IsRegular() {
			return fileContent{}, errors.New("只能修改普通文件")
		}
		existing, err := readLocalFile(root, local)
		if err != nil {
			return fileContent{}, err
		}
		if content.Revision != existing.Revision {
			return fileContent{}, errStaleFile
		}
		mode = info.Mode().Perm()
	} else if !errors.Is(err, fs.ErrNotExist) {
		return fileContent{}, err
	} else if content.Revision != "" {
		return fileContent{}, errStaleFile
	}
	parent := filepath.Dir(local)
	if err := root.MkdirAll(parent, 0755); err != nil {
		return fileContent{}, err
	}
	temp := filepath.Join(parent, ".studio-pi-"+uuid.NewString())
	file, err := root.OpenFile(temp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return fileContent{}, err
	}
	defer root.Remove(temp)
	_, writeErr := io.WriteString(file, content.Content)
	if err := errors.Join(writeErr, file.Close()); err != nil {
		return fileContent{}, err
	}
	if err := root.Rename(temp, local); err != nil {
		return fileContent{}, err
	}
	return fileContent{Content: content.Content, Revision: fmt.Sprintf("%x", sha256.Sum256([]byte(content.Content)))}, nil
}
