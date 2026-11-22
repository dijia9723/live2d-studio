package coding

import (
	"bytes"
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPreviewSQLiteUsesReadOnlyScopedCopy(t *testing.T) {
	dir := t.TempDir()
	filename := filepath.Join(dir, "notes.sqlite")
	db, err := sql.Open("sqlite", filename)
	if err != nil {
		t.Fatal(err)
	}
	const table = `review "notes"`
	if _, err := db.Exec(`
		CREATE TABLE "review ""notes""" ("big" INTEGER, "sample" BLOB, "missing" TEXT);
		CREATE VIEW hidden_view AS SELECT * FROM "review ""notes""";
		WITH RECURSIVE count(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM count WHERE x < 52)
		INSERT INTO "review ""notes""" SELECT 9223372036854775807, x'CAFE', NULL FROM count;`); err != nil {
		db.Close()
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	original, err := os.ReadFile(filename)
	if err != nil {
		t.Fatal(err)
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	data, err := previewSQLite(t.Context(), root, "notes.sqlite", "", 1)
	if err != nil {
		t.Fatal(err)
	}
	if data.Table != table || len(data.Tables) != 1 || len(data.Rows) != 50 || !data.HasMore {
		t.Fatalf("unexpected preview: %#v", data)
	}
	cell := data.Rows[0]
	if *cell[0] != "9223372036854775807" || !strings.Contains(*cell[1], "BLOB 2") || cell[2] != nil {
		t.Fatalf("unexpected rendered value: %#v", cell)
	}
	next, err := previewSQLite(t.Context(), root, "notes.sqlite", table, 2)
	if err != nil || next.HasMore || len(next.Rows) != 2 {
		t.Fatalf("unexpected second page: %#v %v", next, err)
	}
	if _, err := previewSQLite(t.Context(), root, "notes.sqlite", "hidden_view", 1); err == nil {
		t.Fatal("view should not be treated as a regular SQLite table")
	}
	after, err := os.ReadFile(filename)
	if err != nil || !bytes.Equal(original, after) {
		t.Fatal("opening preview modified the original database")
	}
}
