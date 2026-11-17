// 本文件覆盖记忆的去重、跨角色隔离、容量上限、检索工具与重新打开数据库后的持久化。

package memory_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"server/internal/migrate"
	"server/internal/modules/memory"

	"github.com/cloudwego/eino/components/tool"
	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// openDatabase 打开临时 SQLite 库并执行迁移，同时把连接数限制为 1 以模拟单机串行访问。
func openDatabase(t *testing.T, path string, now func() time.Time) (*memory.Service, func() error) {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(path), &gorm.Config{NowFunc: now, Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	sqlDB.SetMaxOpenConns(1)
	if err := db.Exec("PRAGMA foreign_keys = ON").Error; err != nil {
		sqlDB.Close()
		t.Fatal(err)
	}
	if err := migrate.Run(db); err != nil {
		sqlDB.Close()
		t.Fatal(err)
	}
	return &memory.Service{DB: db}, sqlDB.Close
}

// TestMemoryEditAndReopen 验证创建去重、跨角色不可见、编辑冲突、时间戳更新，
// 以及重新打开数据库后的持久化与检索隔离。
func TestMemoryEditAndReopen(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "studio.db")
	now := time.Now().UTC()
	store, closeDB := openDatabase(t, path, func() time.Time { return now })
	t.Cleanup(func() { _ = closeDB() })
	memo, err := store.Create(ctx, "mao", "  喜欢 Earl Grey 红茶  \n")
	if err != nil || memo.Content != "喜欢 Earl Grey 红茶" {
		t.Fatalf("create: %#v, %v", memo, err)
	}
	now = now.Add(time.Second)
	other, err := store.Create(ctx, "mao", "不加糖")
	if err != nil {
		t.Fatal(err)
	}
	duplicate, err := store.Create(ctx, "mao", memo.Content)
	if err != nil || duplicate.ID != memo.ID || !duplicate.UpdatedAt.Equal(memo.UpdatedAt) {
		t.Fatalf("duplicate: %#v, %v", duplicate, err)
	}
	if _, err := store.Update(ctx, "shizuku", memo.ID, "其他内容"); !errors.Is(err, gorm.ErrRecordNotFound) {
		t.Fatalf("cross-character update: %v", err)
	}
	if err := store.Delete(ctx, "shizuku", memo.ID); !errors.Is(err, gorm.ErrRecordNotFound) {
		t.Fatalf("cross-character delete: %v", err)
	}
	if _, err := store.Update(ctx, "mao", memo.ID, other.Content); !errors.Is(err, memory.ErrExists) {
		t.Fatalf("edit to duplicate: %v", err)
	}
	now = now.Add(time.Second)
	updated, err := store.Update(ctx, "mao", memo.ID, "喜欢无糖 EARL GREY 红茶")
	if err != nil || updated.Content != "喜欢无糖 EARL GREY 红茶" || !updated.UpdatedAt.Equal(now) {
		t.Fatalf("update: %#v, %v", updated, err)
	}
	if err := closeDB(); err != nil {
		t.Fatal(err)
	}
	store, closeDB = openDatabase(t, path, func() time.Time { return now })
	rows, err := store.List(ctx, "mao")
	if err != nil || len(rows) != 2 || rows[0].ID != updated.ID || rows[0].Content != updated.Content {
		t.Fatalf("list after reopen: %#v, %v", rows, err)
	}
	for _, character := range []string{"mao", "shizuku", ""} {
		search, err := store.SearchTool(character)
		if err != nil {
			t.Fatal(err)
		}
		searchTool := search.(tool.InvokableTool)
		if _, err := searchTool.InvokableRun(ctx, `{"query":"   "}`); !errors.Is(err, memory.ErrSearchQuery) {
			t.Fatalf("invalid query: %v", err)
		}
		result, err := searchTool.InvokableRun(ctx, `{"query":"earl grey 红茶"}`)
		if err != nil {
			t.Fatal(err)
		}
		var matches []string
		if err := json.Unmarshal([]byte(result), &matches); err != nil {
			t.Fatal(err)
		}
		if character == "mao" && (len(matches) != 1 || matches[0] != updated.Content) {
			t.Fatalf("search: %s", result)
		}
		if character != "mao" && result != "[]" {
			t.Fatalf("search leaked to %q: %s", character, result)
		}
	}
}

// TestMemoryBounds 验证内容长度上限、角色不存在、每角色 100 条容量与最近 8 条读取。
func TestMemoryBounds(t *testing.T) {
	ctx := context.Background()
	store, closeDB := openDatabase(t, filepath.Join(t.TempDir(), "studio.db"), time.Now)
	t.Cleanup(func() { _ = closeDB() })
	if _, err := store.Create(ctx, "mao", strings.Repeat("茶", 301)); !errors.Is(err, memory.ErrContent) {
		t.Fatalf("oversized memory: %v", err)
	}
	if _, err := store.Create(ctx, "missing", "不存在的角色"); !errors.Is(err, gorm.ErrRecordNotFound) {
		t.Fatalf("missing character: %v", err)
	}
	for i := range 100 {
		if _, err := store.Create(ctx, "mao", fmt.Sprintf("喜欢茶 %d", i)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := store.Create(ctx, "mao", "无法再保存"); !errors.Is(err, memory.ErrLimit) {
		t.Fatalf("memory capacity: %v", err)
	}
	if _, err := store.Create(ctx, "shizuku", "独立的记忆容量"); err != nil {
		t.Fatal(err)
	}
	rows, err := store.Recent(ctx, "mao")
	if err != nil || len(rows) != 8 {
		t.Fatalf("recent entries: %d, %v", len(rows), err)
	}
}
