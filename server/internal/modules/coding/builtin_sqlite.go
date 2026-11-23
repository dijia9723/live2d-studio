// builtin_sqlite.go 负责以只读快照方式预览项目内的 SQLite 数据库。
package coding

import (
	"context"
	"database/sql"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"server/internal/pkg"

	"github.com/gin-gonic/gin"
	_ "github.com/glebarez/go-sqlite"
)

const (
	sqlitePreviewMaxSize = 32 << 20
	sqlitePreviewTables  = 100
	sqlitePreviewColumns = 64
	sqlitePreviewRows    = 50
)

type sqlitePreviewPage struct {
	Tables           []string    `json:"tables"`
	Table            string      `json:"table"`
	Columns          []string    `json:"columns"`
	Rows             [][]*string `json:"rows"`
	Page             int         `json:"page"`
	PageSize         int         `json:"page_size"`
	HasMore          bool        `json:"has_more"`
	TablesTruncated  bool        `json:"tables_truncated"`
	ColumnsTruncated bool        `json:"columns_truncated"`
	StaleWAL         bool        `json:"stale_wal"`
}

func (m *Module) sqlitePreview(c *gin.Context) {
	if !m.requireBuiltin(c, "pi.file-manager") {
		return
	}
	root := m.openProject(c, c.Param("project"))
	if root == nil {
		return
	}
	defer root.Close()
	local, err := localPath(c.Query("path"), false)
	if err == nil {
		err = checkFilePath(root, local)
	}
	if err != nil {
		pkg.Fail(c, http.StatusBadRequest, "请选择项目内的 SQLite 文件")
		return
	}
	page, err := strconv.Atoi(c.DefaultQuery("page", "1"))
	if err != nil || page < 1 || page > 1000 || len(c.Query("table")) > 512 {
		pkg.Fail(c, http.StatusBadRequest, "SQLite 预览页码或表名无效")
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Second)
	defer cancel()
	data, err := previewSQLite(ctx, root, local, c.Query("table"), page)
	if err != nil {
		pkg.Fail(c, http.StatusBadRequest, err.Error())
		return
	}
	pkg.OK(c, data)
}

// previewSQLite 先复制出有界快照再用只读连接查询。SQLite 驱动需要原生文件名，
// 复制快照可以避免驱动跟随项目路径变化或打开 -wal/-shm 边车文件。
func previewSQLite(ctx context.Context, root *os.Root, local, chosenTable string, page int) (sqlitePreviewPage, error) {
	data := sqlitePreviewPage{
		Tables: []string{}, Columns: []string{}, Rows: [][]*string{}, Page: page, PageSize: sqlitePreviewRows,
	}
	// 复制一份有界的主库文件到临时目录，让驱动无法跟随项目路径变化或打开边车文件。
	scratch, err := os.MkdirTemp("", "studio-sqlite-preview-")
	if err != nil {
		return data, errors.New("无法准备 SQLite 预览")
	}
	defer os.RemoveAll(scratch)
	path := filepath.Join(scratch, "view.sqlite")
	if err := copySQLiteSnapshot(root, local, path); err != nil {
		return data, err
	}
	wal, err := root.Lstat(local + "-wal")
	data.StaleWAL = err == nil && wal.Mode().IsRegular() && wal.Size() > 32

	uriPath := filepath.ToSlash(path)
	if !strings.HasPrefix(uriPath, "/") {
		uriPath = "/" + uriPath
	}
	uri := url.URL{Scheme: "file", Path: uriPath}
	uri.RawQuery = url.Values{
		"mode": {"ro"}, "immutable": {"1"}, "_pragma": {"query_only(1)", "trusted_schema(OFF)"},
	}.Encode()
	db, err := sql.Open("sqlite", uri.String())
	if err != nil {
		return data, errors.New("无法以只读方式打开 SQLite 预览")
	}
	defer db.Close()
	if err := readSQLitePreview(ctx, db, chosenTable, &data); err != nil {
		return data, err
	}
	return data, nil
}

func copySQLiteSnapshot(root *os.Root, local, path string) error {
	info, err := root.Lstat(local)
	if err != nil || !info.Mode().IsRegular() || info.Size() > sqlitePreviewMaxSize {
		return errors.New("SQLite 预览支持不超过 32 MiB 的普通文件")
	}
	source, err := root.Open(local)
	if err != nil {
		return errors.New("无法读取 SQLite 文件")
	}
	defer source.Close()
	info, err = source.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > sqlitePreviewMaxSize {
		return errors.New("SQLite 预览支持不超过 32 MiB 的普通文件")
	}
	var header [16]byte
	if _, err := io.ReadFull(source, header[:]); err != nil || string(header[:]) != "SQLite format 3\x00" {
		return errors.New("文件没有有效的 SQLite 数据库文件头")
	}
	target, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return errors.New("无法准备 SQLite 预览")
	}
	reader := io.MultiReader(strings.NewReader(string(header[:])), source)
	size, err := io.Copy(target, io.LimitReader(reader, sqlitePreviewMaxSize+1))
	if closeErr := target.Close(); err != nil || closeErr != nil || size > sqlitePreviewMaxSize {
		return errors.New("无法读取 SQLite 文件或文件超过预览大小")
	}
	return nil
}

func readSQLitePreview(ctx context.Context, db *sql.DB, chosenTable string, data *sqlitePreviewPage) error {
	tables, err := sqliteNames(ctx, db, `
		SELECT name FROM pragma_table_list
		WHERE schema = 'main' AND type = 'table' AND substr(lower(name), 1, 7) != 'sqlite_'
		  AND length(CAST(name AS BLOB)) <= 512
		ORDER BY name LIMIT ?`, sqlitePreviewTables+1)
	if err != nil {
		return errors.New("无法读取 SQLite 库结构")
	}
	data.TablesTruncated = len(tables) > sqlitePreviewTables
	data.Tables = tables[:min(len(tables), sqlitePreviewTables)]
	if chosenTable == "" {
		if len(data.Tables) == 0 {
			return nil
		}
		chosenTable = data.Tables[0]
	}
	// 只查询 main schema 中的普通表，不触发表文件自带的虚拟表、影子表或任意视图。
	var allowedTable string
	if err := db.QueryRowContext(ctx, `
		SELECT name FROM pragma_table_list
		WHERE schema = 'main' AND type = 'table' AND substr(lower(name),1,7) != 'sqlite_' AND name = ?`, chosenTable).
		Scan(&allowedTable); err != nil {
		return errors.New("未找到可预览的 SQLite 表")
	}
	data.Table = allowedTable
	columns, err := sqliteNames(ctx, db,
		"SELECT name FROM pragma_table_xinfo(?, 'main') WHERE hidden = 0 AND length(CAST(name AS BLOB)) <= 512 ORDER BY cid LIMIT ?",
		allowedTable, sqlitePreviewColumns+1)
	if err != nil {
		return errors.New("无法读取 SQLite 表列")
	}
	data.ColumnsTruncated = len(columns) > sqlitePreviewColumns
	data.Columns = columns[:min(len(columns), sqlitePreviewColumns)]
	if len(data.Columns) == 0 {
		return nil
	}
	// 数据用占位符绑定，标识符则按已校验的 main schema 名称加引号；
	// 所有单元格渲染成有界字符串，保证 64 位整数不丢失精度。
	limitedColumns := make([]string, 0, len(data.Columns))
	for _, column := range data.Columns {
		id := sqliteIdentifier(column)
		limitedColumns = append(limitedColumns, "CASE typeof("+id+") WHEN 'blob' THEN '[BLOB ' || length("+id+
			") || ' 字节]' ELSE CASE WHEN length(CAST("+id+" AS TEXT)) > 320 THEN substr(CAST("+id+
			" AS TEXT),1,320)||'…' ELSE CAST("+id+" AS TEXT) END END")
	}
	query := "SELECT " + strings.Join(limitedColumns, ", ") + " FROM main." + sqliteIdentifier(allowedTable) + " LIMIT ? OFFSET ?"
	rows, err := db.QueryContext(ctx, query, sqlitePreviewRows+1, (data.Page-1)*sqlitePreviewRows)
	if err != nil {
		return errors.New("无法读取 SQLite 数据行")
	}
	defer rows.Close()
	for rows.Next() {
		if len(data.Rows) == sqlitePreviewRows {
			data.HasMore = true
			break
		}
		var values = make([]*string, len(data.Columns))
		destinations := make([]any, len(values))
		for i := range destinations {
			destinations[i] = &values[i]
		}
		if err := rows.Scan(destinations...); err != nil {
			return errors.New("无法读取 SQLite 数据行")
		}
		data.Rows = append(data.Rows, values)
	}
	if rows.Err() != nil {
		return errors.New("读取 SQLite 数据行已失败或超时")
	}
	return nil
}

func sqliteNames(ctx context.Context, db *sql.DB, query string, args ...any) ([]string, error) {
	rows, err := db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	names := []string{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		names = append(names, name)
	}
	return names, rows.Err()
}

func sqliteIdentifier(name string) string { return `"` + strings.ReplaceAll(name, `"`, `""`) + `"` }
