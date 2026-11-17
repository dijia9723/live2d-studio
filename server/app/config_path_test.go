package app

import (
	"path/filepath"
	"testing"
)

func TestPackagedConfigIndependentOfWorkingDirectory(t *testing.T) {
	root := t.TempDir()
	workspace := filepath.Join(root, "workspace")
	bin := filepath.Join(workspace, "bin")
	executable := filepath.Join(bin, "Live2DStudio.exe")
	// The directories, not the presence of config.yaml, select the data root:
	// first launch also needs to store settings beside the packaged executable.
	directories := map[string]bool{
		filepath.Join(bin, "configs"):                 true,
		filepath.Join(workspace, "server", "configs"): true,
	}
	exists := func(dir string) bool { return directories[dir] }
	for _, cwd := range []string{workspace, filepath.Join(workspace, "server"), bin, root} {
		got := configPathFor("", executable, cwd, exists)
		if want := filepath.Join(bin, "configs", "config.yaml"); got != want {
			t.Errorf("cwd %s selected %s, want %s", cwd, got, want)
		}
		if dataRoot := filepath.Dir(filepath.Dir(got)); dataRoot != bin {
			t.Errorf("packaged data root changed to %s", dataRoot)
		}
	}
}

func TestGoRunConfigFallsBackToSourceDirectories(t *testing.T) {
	root := t.TempDir()
	workspace := filepath.Join(root, "workspace")
	executable := filepath.Join(root, "go-build", "exe", "api")
	server := filepath.Join(workspace, "server")
	exists := func(dir string) bool { return dir == filepath.Join(server, "configs") }
	for _, cwd := range []string{workspace, server} {
		got := configPathFor("", executable, cwd, exists)
		if want := filepath.Join(server, "configs", "config.yaml"); got != want {
			t.Errorf("go run from %s selected %s, want %s", cwd, got, want)
		}
	}
}

func TestExplicitConfigWinsOverPackagedConfig(t *testing.T) {
	root := t.TempDir()
	cwd := filepath.Join(root, "working")
	executable := filepath.Join(root, "bin", "Live2DStudio.exe")
	for _, explicit := range []string{filepath.Join(root, "custom", "config.yaml"), filepath.Join("custom", "config.yaml")} {
		got := configPathFor(explicit, executable, cwd, func(string) bool {
			t.Fatal("explicit config must skip automatic directory selection")
			return false
		})
		want := explicit
		if !filepath.IsAbs(explicit) {
			want = filepath.Join(cwd, explicit)
		}
		if got != want {
			t.Errorf("explicit config resolved to %s, want %s", got, want)
		}
	}
}

func TestConfigFallbackAnchoredToExecutable(t *testing.T) {
	root := t.TempDir()
	executable := filepath.Join(root, "bin", "Live2DStudio.exe")
	got := configPathFor("", executable, filepath.Join(root, "unrelated"), func(string) bool { return false })
	if want := filepath.Join(root, "bin", "configs", "config.yaml"); got != want {
		t.Fatalf("fallback %s, want %s", got, want)
	}
}
