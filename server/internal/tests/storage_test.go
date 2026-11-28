package tests

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"server/internal/bootstrap"
	"server/internal/config"
	"server/internal/model"
	"server/internal/modules/desktop"
)

type storageDirectoryPicker struct {
	path string
}

func (*storageDirectoryPicker) Pet(bool, *desktop.PetHandoff) {}
func (*storageDirectoryPicker) Coding(bool)                   {}
func (*storageDirectoryPicker) Pin(bool)                      {}
func (p *storageDirectoryPicker) PickDirectory(string, string) (string, error) {
	return p.path, nil
}

type storageStatus struct {
	Current     string `json:"current_directory"`
	Next        string `json:"next_directory"`
	CanChoose   bool   `json:"can_choose"`
	OverrideEnv bool   `json:"environment_override"`
}

func TestStorageDirectorySelection(t *testing.T) {
	t.Setenv("STUDIO_DATA_DIR", "")
	root := t.TempDir()
	path := filepath.Join(root, "configs", "config.yaml")
	if err := os.Mkdir(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	yaml := "# User config\ndata_dir: original\n"
	if err := os.WriteFile(path, []byte(yaml), 0600); err != nil {
		t.Fatal(err)
	}
	original := filepath.Join(root, "original")
	target := filepath.Join(root, "新 数据目录")
	targetConfig := config.Defaults()
	targetConfig.DataDir = target
	func() {
		app, err := bootstrap.New(targetConfig)
		if err != nil {
			t.Fatal(err)
		}
		defer app.Close()
		if err := app.DB.Create(&model.CodingProject{ID: "existing", Name: "Existing Project", Path: target}).Error; err != nil {
			t.Fatal(err)
		}
	}()

	const endpoint = "/settings/storage"
	picker := &storageDirectoryPicker{path: target}
	start := func() *bootstrap.App {
		cfg, err := config.Load(path)
		if err != nil {
			t.Fatal(err)
		}
		app, err := bootstrap.New(cfg)
		if err != nil {
			t.Fatal(err)
		}
		return app
	}
	func() {
		app := start()
		defer app.Close()
		if got := decode[storageStatus](t, request(t, app, http.MethodGet, endpoint, nil)); got != (storageStatus{Current: original, Next: original}) {
			t.Fatalf("headless status = %+v", got)
		}
		if w := request(t, app, http.MethodPost, endpoint, nil); w.Code != http.StatusConflict {
			t.Fatalf("headless selection = %d: %s", w.Code, w.Body)
		}
		app.Desktop.Set(picker)
		want := storageStatus{Current: original, Next: target, CanChoose: true}
		if got := decode[storageStatus](t, request(t, app, http.MethodPost, endpoint, nil)); got != want {
			t.Fatalf("selection = %+v, want %+v", got, want)
		}
		picker.path = ""
		if got := decode[storageStatus](t, request(t, app, http.MethodPost, endpoint, nil)); got != want {
			t.Fatalf("cancelled selection = %+v, want %+v", got, want)
		}
		picker.path = filepath.Join(root, "missing")
		if w := request(t, app, http.MethodPost, endpoint, nil); w.Code != http.StatusInternalServerError {
			t.Fatalf("invalid selection = %d: %s", w.Code, w.Body)
		}
		if got := decode[storageStatus](t, request(t, app, http.MethodGet, endpoint, nil)); got != want {
			t.Fatalf("status after failed selection = %+v, want %+v", got, want)
		}
	}()

	func() {
		app := start()
		defer app.Close()
		app.Desktop.Set(picker)
		if got := decode[storageStatus](t, request(t, app, http.MethodGet, endpoint, nil)); got != (storageStatus{Current: target, Next: target, CanChoose: true}) {
			t.Fatalf("status after restart = %+v", got)
		}
		var project model.CodingProject
		if err := app.DB.First(&project, "id = ?", "existing").Error; err != nil {
			t.Fatalf("read project from selected directory: %v", err)
		}
		picker.path = original
		if got := decode[storageStatus](t, request(t, app, http.MethodPost, endpoint, nil)); got.Next != original {
			t.Fatalf("switch back = %+v", got)
		}
	}()
	if data, err := os.ReadFile(path); err != nil || string(data) != yaml {
		t.Fatalf("YAML changed: %q, %v", data, err)
	}
	if _, err := os.Stat(filepath.Join(original, "studio.db")); err != nil {
		t.Fatalf("original database: %v", err)
	}

	t.Setenv("STUDIO_DATA_DIR", target)
	app := start()
	defer app.Close()
	app.Desktop.Set(picker)
	if got := decode[storageStatus](t, request(t, app, http.MethodGet, endpoint, nil)); got != (storageStatus{Current: target, Next: target, OverrideEnv: true}) {
		t.Fatalf("environment override = %+v", got)
	}
	if w := request(t, app, http.MethodPost, endpoint, nil); w.Code != http.StatusConflict {
		t.Fatalf("selection under environment override = %d: %s", w.Code, w.Body)
	}
}
