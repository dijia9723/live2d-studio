// 本文件覆盖场景素材（图片、视频和 HTML）：类型嗅探、增删查、路径安全、Range 请求
// 与大小限制。

package tests

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"io"
	"mime/multipart"
	"net/http/httptest"
	"net/textproto"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"server/internal/bootstrap"
	"server/internal/model"
	"server/internal/modules/sceneassets"
)

// sceneUpload 以 multipart 上传素材，claimedType 用于验证服务端不信任客户端声明。
func sceneUpload(t *testing.T, app *bootstrap.App, name, claimedType string, data []byte) *httptest.ResponseRecorder {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	header := textproto.MIMEHeader{}
	header.Set("Content-Disposition", fmt.Sprintf(`form-data; name="file"; filename="%s"`, name))
	header.Set("Content-Type", claimedType)
	part, err := writer.CreatePart(header)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = part.Write(data)
	_ = writer.Close()
	r := httptest.NewRequest("POST", "http://127.0.0.1:12393/api/v1/scene-assets", &body)
	r.Header.Set("Content-Type", writer.FormDataContentType())
	r.Header.Set("X-Studio-Client", "1")
	w := httptest.NewRecorder()
	app.Router.ServeHTTP(w, r)
	return w
}

// sceneMedia 请求素材文件，byteRange 非空时模拟视频分段请求。
func sceneMedia(app *bootstrap.App, method, url, byteRange string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "http://127.0.0.1:12393"+url, nil)
	if byteRange != "" {
		r.Header.Set("Range", byteRange)
	}
	w := httptest.NewRecorder()
	app.Router.ServeHTTP(w, r)
	return w
}

// mp4Sample 构造带合法 ftyp box 的最小 MP4 头，供类型嗅探使用。
func mp4Sample() []byte {
	header := make([]byte, 24)
	binary.BigEndian.PutUint32(header, 24)
	copy(header[4:], "ftypmp42")
	copy(header[16:], "mp42isom")
	return append(header, []byte("video range test payload")...)
}

// TestSceneAssetsUploadListDeleteAndContentTypes 覆盖图片/视频上传、按真实内容
// 识别类型、列表倒序、读取内容一致与删除后的清理。
func TestSceneAssetsUploadListDeleteAndContentTypes(t *testing.T) {
	app := newApp(t)
	samples := []struct {
		name, kind, mime, ext string
		data                  []byte
	}{
		{"image.png", "image", "image/png", ".png", append([]byte("\x89PNG\r\n\x1a\n"), make([]byte, 20)...)},
		{"image.jpg", "image", "image/jpeg", ".jpg", append([]byte{0xff, 0xd8, 0xff}, make([]byte, 20)...)},
		{"image.webp", "image", "image/webp", ".webp", []byte("RIFF\x20\x00\x00\x00WEBPVP8 \x00\x00\x00\x00")},
		{"image.gif", "image", "image/gif", ".gif", []byte("GIF89a\x01\x00\x01\x00\x00\x00\x00")},
		{"video.mp4", "video", "video/mp4", ".mp4", mp4Sample()},
		{"video.webm", "video", "video/webm", ".webm", []byte{0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84, 'w', 'e', 'b', 'm'}},
	}
	var uploaded []model.SceneAsset
	for _, sample := range samples {
		t.Run(sample.mime, func(t *testing.T) {
			// 伪造的 multipart 类型不得覆盖服务端的内容嗅探结果。
			asset := decode[model.SceneAsset](t, sceneUpload(t, app, sample.name, "text/javascript", sample.data))
			if asset.Name != sample.name || asset.Kind != sample.kind || asset.MIMEType != sample.mime || asset.Size != int64(len(sample.data)) || !strings.HasPrefix(asset.URL, "/scene-media/"+asset.ID) || !strings.HasSuffix(asset.URL, sample.ext) {
				t.Fatalf("unexpected upload metadata: %+v", asset)
			}
			w := sceneMedia(app, "GET", asset.URL, "")
			if w.Code != 200 || w.Header().Get("Content-Type") != sample.mime || !bytes.Equal(w.Body.Bytes(), sample.data) {
				t.Fatalf("stored media content/type was changed: %d", w.Code)
			}
			uploaded = append(uploaded, asset)
		})
	}
	listed := decode[[]model.SceneAsset](t, request(t, app, "GET", "/scene-assets", nil))
	if len(listed) != len(samples) || listed[0].ID != uploaded[len(uploaded)-1].ID {
		t.Fatal("uploaded backgrounds were not listed newest first")
	}
	for _, asset := range uploaded {
		if w := request(t, app, "DELETE", "/scene-assets/"+asset.ID, nil); w.Code != 200 {
			t.Fatal(w.Body.String())
		}
		if sceneMedia(app, "GET", asset.URL, "").Code != 404 {
			t.Error("deleted media remains accessible")
		}
		if _, err := os.Stat(filepath.Join(app.Config.DataDir, "scene-media", strings.TrimPrefix(asset.URL, "/scene-media/"))); !os.IsNotExist(err) {
			t.Error("deleted media file remains on disk")
		}
	}
	if result := decode[[]model.SceneAsset](t, request(t, app, "GET", "/scene-assets", nil)); len(result) != 0 {
		t.Fatal("deleted backgrounds remain in the database")
	}
	if request(t, app, "DELETE", "/scene-assets/"+uploaded[0].ID, nil).Code != 404 {
		t.Fatal("repeated deletion did not report a missing background")
	}
}

// TestSceneAssetsRejectScriptsAndUnsafePaths 校验脚本、SVG、伪装视频与空文件被
// 拒绝，越权路径返回 404，且失败上传不会残留临时文件。
func TestSceneAssetsRejectScriptsAndUnsafePaths(t *testing.T) {
	app := newApp(t)
	for _, data := range [][]byte{[]byte("<script>alert('not an image')</script>"), []byte("<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>"), []byte{0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x82, 0x88, 'm', 'a', 't', 'r', 'o', 's', 'k', 'a'}, {}} {
		if w := sceneUpload(t, app, "fake.png", "image/png", data); w.Code != 400 {
			t.Fatalf("untrusted media accepted: %d", w.Code)
		}
	}
	if w := sceneUpload(t, app, "fake.html", "text/html", []byte("\x89PNG\r\n\x1a\n")); w.Code != 400 {
		t.Fatalf("binary upload masquerading as HTML returned %d", w.Code)
	}
	for _, path := range []string{"/scene-media/", "/scene-media/../studio.db", "/scene-media/%2e%2e%2fstudio.db", "/scene-media/studio.db", "/scene-media/00000000-0000-0000-0000-000000000000.png", "/scene-media/00000000-0000-0000-0000-000000000000.png/extra"} {
		if w := sceneMedia(app, "GET", path, ""); w.Code != 404 {
			t.Errorf("unsafe or missing media path returned %d: %s", w.Code, path)
		}
	}
	files, err := os.ReadDir(filepath.Join(app.Config.DataDir, "scene-media"))
	if err != nil || len(files) != 0 {
		t.Fatal("rejected uploads left temporary files")
	}
}

func TestSceneHTMLBackgroundLifecycle(t *testing.T) {
	app := newApp(t)
	for _, sample := range []struct{ name, source string }{
		{"scene.html", "<!doctype html><html><head><title>舞台</title></head><body><script>void 0</script></body></html>"},
		{"fragment.HTM", "\ufeff\n<style>body{background:#315}</style>"},
	} {
		data := []byte(sample.source)
		asset := decode[model.SceneAsset](t, sceneUpload(t, app, sample.name, "application/octet-stream", data))
		if asset.Name != sample.name || asset.Kind != "html" || asset.MIMEType != "text/html; charset=utf-8" || asset.Size != int64(len(data)) || asset.URL != "/scene-media/"+asset.ID+".html" {
			t.Fatalf("unexpected HTML background metadata: %+v", asset)
		}
		listed := decode[[]model.SceneAsset](t, request(t, app, "GET", "/scene-assets", nil))
		if len(listed) != 1 || listed[0].ID != asset.ID || listed[0].Kind != "html" || listed[0].URL != asset.URL {
			t.Fatalf("HTML background missing from library: %+v", listed)
		}
		w := sceneMedia(app, "GET", asset.URL, "")
		if w.Code != 200 || !bytes.Equal(w.Body.Bytes(), data) || w.Header().Get("Content-Type") != "text/plain; charset=utf-8" || w.Header().Get("Content-Disposition") != "attachment" || w.Header().Get("X-Content-Type-Options") != "nosniff" {
			t.Fatalf("HTML source was not served as an inert attachment: %d %v", w.Code, w.Header())
		}
		if request(t, app, "DELETE", "/scene-assets/"+asset.ID, nil).Code != 200 || sceneMedia(app, "GET", asset.URL, "").Code != 404 {
			t.Fatal("deleted HTML background remains accessible")
		}
	}
}

// TestSceneVideoRangeAndHead 覆盖视频的字节区间请求、HEAD 元数据与非法区间拒绝。
func TestSceneVideoRangeAndHead(t *testing.T) {
	app := newApp(t)
	data := mp4Sample()
	asset := decode[model.SceneAsset](t, sceneUpload(t, app, "background.mp4", "video/mp4", data))
	w := sceneMedia(app, "GET", asset.URL, "bytes=4-11")
	if w.Code != 206 || w.Header().Get("Accept-Ranges") != "bytes" || w.Header().Get("Content-Range") != fmt.Sprintf("bytes 4-11/%d", len(data)) || !bytes.Equal(w.Body.Bytes(), data[4:12]) {
		t.Fatalf("video byte range not served correctly: %d %v", w.Code, w.Header())
	}
	w = sceneMedia(app, "HEAD", asset.URL, "")
	if w.Code != 200 || w.Body.Len() != 0 || w.Header().Get("Content-Length") != fmt.Sprint(len(data)) {
		t.Fatal("HEAD response did not include the video size without its body")
	}
	if w = sceneMedia(app, "GET", asset.URL, "bytes=99999-"); w.Code != 416 {
		t.Fatal("invalid video range was not rejected")
	}
}

// zeroReader 生成无限全零数据，避免为超限用例真的分配大块内存。
type zeroReader struct{}

func (zeroReader) Read(p []byte) (int, error) {
	clear(p)
	return len(p), nil
}

// sizedSceneUpload 用手写 multipart 分片构造任意大小的上传，避免真实分配内存。
func sizedSceneUpload(t *testing.T, app *bootstrap.App, name string, prefix []byte, size int64) *httptest.ResponseRecorder {
	t.Helper()
	const boundary = "scene-size-test"
	header := "--" + boundary + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"" + name + "\"\r\n\r\n"
	tail := "\r\n--" + boundary + "--\r\n"
	body := io.MultiReader(strings.NewReader(header), bytes.NewReader(prefix), io.LimitReader(zeroReader{}, size-int64(len(prefix))), strings.NewReader(tail))
	r := httptest.NewRequest("POST", "http://127.0.0.1:12393/api/v1/scene-assets", body)
	r.Header.Set("Content-Type", "multipart/form-data; boundary="+boundary)
	r.Header.Set("X-Studio-Client", "1")
	w := httptest.NewRecorder()
	app.Router.ServeHTTP(w, r)
	return w
}

// TestSceneAssetSizeLimitsAndLargeVideo 覆盖图片与视频各自的体积上限，并确认
// 大视频不会被通用 JSON 请求体限制误拦。
func TestSceneAssetSizeLimitsAndLargeVideo(t *testing.T) {
	app := newApp(t)
	png := []byte("\x89PNG\r\n\x1a\n")
	if w := sizedSceneUpload(t, app, "background.png", png, sceneassets.ImageLimit+1); w.Code != 413 {
		t.Fatalf("oversized image returned %d", w.Code)
	}
	if w := sizedSceneUpload(t, app, "background.mp4", mp4Sample(), sceneassets.VideoLimit+1); w.Code != 413 {
		t.Fatalf("oversized video returned %d", w.Code)
	}
	if w := sizedSceneUpload(t, app, "background.html", []byte("<!doctype html>"), sceneassets.HTMLLimit+1); w.Code != 413 {
		t.Fatalf("oversized HTML returned %d", w.Code)
	}
	files, _ := os.ReadDir(filepath.Join(app.Config.DataDir, "scene-media"))
	if len(files) != 0 {
		t.Fatal("oversized uploads were not cleaned up")
	}
	// 回归用例：通用的 26MB JSON 请求体限制不能拦住视频上传。
	asset := decode[model.SceneAsset](t, sizedSceneUpload(t, app, "background.mp4", mp4Sample(), 27<<20))
	if asset.Kind != "video" || asset.Size != 27<<20 {
		t.Fatal("large video upload did not bypass the JSON request limit")
	}
	if request(t, app, "DELETE", "/scene-assets/"+asset.ID, nil).Code != 200 {
		t.Fatal("large background cleanup failed")
	}
}
