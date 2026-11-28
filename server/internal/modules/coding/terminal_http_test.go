//go:build windows || linux || darwin

// terminal_http_test.go 覆盖终端 HTTP 路由的工作区校验与退出码流式输出。
package coding

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"server/internal/middleware"
	"server/internal/model"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
)

func TestTerminalHTTPUsesWorkspaceGuardAndStreamsExit(t *testing.T) {
	t.Setenv("STUDIO_CONTAINER", "")
	home := t.TempDir()
	db, err := gorm.Open(sqlite.Open(filepath.Join(home, "test.db")), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := db.AutoMigrate(&model.CodingProject{}); err != nil {
		t.Fatal(err)
	}
	home, err = filepath.EvalSymlinks(home)
	if err != nil {
		t.Fatal(err)
	}
	project := model.CodingProject{ID: "fixture", Path: home, Name: "test terminal"}
	if err := db.Create(&project).Error; err != nil {
		t.Fatal(err)
	}
	terminals := NewTerminalService()
	t.Cleanup(terminals.Close)
	router := gin.New()
	router.Use(middleware.LocalOnly(nil))
	host := &Module{DB: db, Terminal: terminals}
	host.registerTerminal(router.Group("/api/v1/coding", middleware.WorkspaceOnly(nil)))
	server := httptest.NewServer(router)
	t.Cleanup(server.Close)
	client := server.Client()
	client.Timeout = 15 * time.Second

	call := func(method, path string, body any, origin string, status int) []byte {
		t.Helper()
		payload, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		req, err := http.NewRequest(method, server.URL+"/api/v1/coding/projects/"+path, bytes.NewReader(payload))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Studio-Client", "1")
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		response, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		data, err := io.ReadAll(response.Body)
		if err != nil || response.StatusCode != status {
			t.Fatalf("%s %s: status %d, error %v, body %s", method, path, response.StatusCode, err, data)
		}
		return data
	}

	size := terminalSize{80, 24}
	stem := "fixture/terminals"
	call("POST", stem, size, "http://localhost:1", http.StatusForbidden)
	var created struct {
		Data struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(call("POST", stem, size, server.URL, http.StatusOK), &created); err != nil || created.Data.ID == "" {
		t.Fatalf("invalid terminal id: %v", err)
	}
	address := stem + "/" + created.Data.ID
	call("GET", "unknown/terminals/"+created.Data.ID+"/events", nil, server.URL, http.StatusNotFound)
	command := "exit 9\n"
	if runtime.GOOS == "windows" {
		command = "exit 9\r"
	}
	call("POST", address+"/input", map[string][]byte{"data": []byte(command)}, server.URL, http.StatusOK)
	events := call("GET", address+"/events", nil, server.URL, http.StatusOK)
	if !strings.Contains(string(events), `data: {"type":"exit","code":9}`) {
		t.Fatalf("terminal did not stream its exit status: %s", events)
	}
}
