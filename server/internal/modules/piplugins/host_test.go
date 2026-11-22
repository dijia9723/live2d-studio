package piplugins

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"html"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	if len(os.Args) == 2 && os.Args[1] == "-pi-plugin-host" {
		os.Exit(RunPluginWorker(os.Stdin, os.Stdout))
	}
	os.Exit(m.Run())
}

func runtimeFixture(t *testing.T) []byte {
	t.Helper()
	var archive bytes.Buffer
	writer := zip.NewWriter(&archive)
	for name, value := range map[string]string{
		"manifest.json": `{"schemaVersion":1,"id":"runtime.fixture","name":"Worker","version":"1.0.0",
			"main":"main.js","ui":{"panel":"renderer/index.html"},
			"contributes":{
				"commands":[{"id":"fixture.open","title":"Open"},{"id":"fixture.complete","title":"Complete"}],
				"agentTools":[{"name":"echo","description":"Echo","risk":"low","schema":{"type":"object"}}],
				"settings":[{"key":"greeting","type":"string","default":"Initial greeting","title":"Greeting"}],
				"services":[{"id":"timer"}],
				"bus":{"publish":["runtime.fixture.tick"],"subscribe":["runtime.other.**"]}
			},
			"permissions":["ui.panel","notify","agent.tool.register","background.service","bus.publish","bus.subscribe","models.list","agent.complete"]
		}`,
		"main.js": `let timer;
			const helper = require("./lib/helper");
			module.exports = {
				async onLoad() {
					if (typeof process !== "undefined" || typeof fetch !== "undefined") throw Error("Runtime isolation failed");
					try { require("node:fs"); throw Error("Native modules must be disabled"); } catch (error) {
						if (error.message === "Native modules must be disabled") throw error;
					}
					const settings = await pi.plugin.getSettings();
					await pi.commands.register({
						id:"fixture.open",
						run() {
							pi.storage.set("count", (pi.storage.get("count") || 0) + 1);
							pi.ui.openPanel();
							pi.ui.showToast(settings.greeting);
						},
					});
					await pi.commands.register({
						id:"fixture.complete",
						async run() {
							const models = await pi.models.list();
							pi.ui.showToast((await pi.agent.complete({modelKey:models[0].key, system:"System", messages:[{role:"user",content:"Fixture prompt"}], maxTokens: 999})).text);
						},
					});
					pi.agent.registerTool({name:"echo", execute(args) {return {...args, id:pi.plugin.getId(), count:pi.storage.get("count"), marker:helper};}});
					pi.services.register({id:"timer",start(){timer=setInterval(() => pi.ui.showToast("resident tick"), 300)},stop(){clearInterval(timer)}});
				},
				onPanelInvoke(channel, args) { return { channel, args }; },
			};`,
		"lib/helper.js":   `module.exports = require("./detail.json").marker;`,
		"lib/detail.json": `{"marker":"same-package module"}`,
		"renderer/index.html": `<!doctype html><html><head><meta http-equiv="refresh" content="1; url=https://example.invalid"/>
			<script src="./valid.js"></script><script src="https://example.invalid/script.js"></script></head>
			<body><h1>Fixture panel</h1><iframe src="https://example.invalid"></iframe><a href="https://example.invalid">Example</a></body></html>`,
		"renderer/valid.js": `document.body?.setAttribute("data-loaded","yes");`,
	} {
		file, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := io.WriteString(file, value); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return archive.Bytes()
}

func TestPluginExecutableHostLifecycle(t *testing.T) {
	desktop := false
	m := New(t.TempDir(), func() bool { return desktop })
	m.ConfigureHost()
	m.ConfigureHostCompletion(func() (HostCompletionModel, error) {
		return HostCompletionModel{Key: "mock/model", Name: "Mock"}, nil
	}, func(ctx context.Context, input HostCompletionRequest) (string, error) {
		if ctx.Err() != nil || input.ModelKey != "mock/model" || input.Prompt != "Fixture prompt" ||
			input.System != "System" || input.MaxTokens != 512 {
			t.Errorf("unexpected model completion host request: %#v", input)
		}
		return "bridged model reply", nil
	})
	t.Cleanup(m.CloseHost)
	router := registryRouter(m)
	item := readResult[Plugin](t, uploadPlugin(t, router, runtimeFixture(t)))
	endpoint := "/" + item.ID
	enable := func(body string) int {
		return requestPlugin(router, "PUT", endpoint, "application/json", strings.NewReader(body), true).Code
	}
	if code := enable(`{"enabled":true,"execute":true}`); code != http.StatusConflict {
		t.Fatalf("headless runtime granted: %d", code)
	}
	desktop = true
	if code := enable(`{"enabled":true}`); code != http.StatusOK {
		t.Fatalf("could not enable display-only plugin: %d", code)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if tools := m.HostAgentTools(ctx); len(tools) != 0 {
		t.Fatalf("old grant exposed executable tools: %#v", tools)
	}
	if code := enable(`{"enabled":true,"execute":true}`); code != http.StatusOK {
		t.Fatalf("desktop grant failed: %d", code)
	}
	command := endpoint + "/runtime/command"
	run := func() hostResponse {
		return readResult[hostResponse](t, requestPlugin(router, "POST", command, "application/json", strings.NewReader(`{"id":"fixture.open"}`), true))
	}
	first := run()
	if len(first.Events) != 2 || first.Events[0].Type != "panel" || first.Events[1].Text != "Initial greeting" {
		t.Fatalf("unexpected command events: %#v", first)
	}
	completion := readResult[hostResponse](t, requestPlugin(router, "POST", command, "application/json",
		strings.NewReader(`{"id":"fixture.complete"}`), true))
	if len(completion.Events) != 1 || completion.Events[0].Text != "bridged model reply" {
		t.Fatalf("unexpected model completion from plugin worker: %#v", completion)
	}
	settings := endpoint + "/runtime/settings"
	update := requestPlugin(router, "PUT", settings, "application/json", strings.NewReader(`{"greeting":"Updated greeting"}`), true)
	readResult[map[string]json.RawMessage](t, update)
	second := run()
	if len(second.Events) != 2 || second.Events[1].Text != "Updated greeting" {
		t.Fatalf("command kept stale settings: %#v", second)
	}
	raw, err := m.CallHostAgentTool(ctx, item.ID, "echo", json.RawMessage(`{"text":"Hello"}`))
	if err != nil || !strings.Contains(string(raw), `"count":2`) || !strings.Contains(string(raw), `"marker":"same-package module"`) ||
		!strings.Contains(string(raw), `"id":"runtime.fixture"`) {
		t.Fatalf("unexpected tool reply %s: %v", raw, err)
	}
	document := readResult[map[string]string](t, requestPlugin(router, "POST", endpoint+"/runtime/view", "application/json", strings.NewReader(`{"id":"panel"}`), true))["html"]
	if !strings.Contains(document, "data:text/javascript;base64,") || !strings.Contains(document, "studio-plugin-init") ||
		!strings.Contains(html.UnescapeString(document), "connect-src 'none'") || strings.Contains(document, "example.invalid") ||
		strings.Contains(document, "&amp;&amp;") {
		t.Fatalf("unexpected isolated panel: %s", document)
	}
	channel := readResult[map[string]json.RawMessage](t, requestPlugin(router, "POST", endpoint+"/runtime/bridge", "application/json", strings.NewReader(`{"method":"fixture.msg","payload":{"data":3}}`), true))
	if !strings.Contains(string(channel["value"]), `"channel":"fixture.msg"`) {
		t.Fatalf("unexpected bridge reply: %#v", channel)
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		updates := readResult[[]hostNotification](t, requestPlugin(router, "GET", "/runtime/events", "", nil, true))
		if len(updates) != 0 && updates[0].Text == "resident tick" {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if time.Now().After(deadline) {
		t.Fatal("resident service did not emit its asynchronous event")
	}
	if code := enable(`{"enabled":false}`); code != http.StatusOK {
		t.Fatalf("could not revoke runtime: %d", code)
	}
	if _, err := m.CallHostAgentTool(ctx, item.ID, "echo", json.RawMessage(`{}`)); err == nil {
		t.Fatal("disabled executable plugin still ran")
	}
}

func TestOfficialHelloPluginExecutable(t *testing.T) {
	path := os.Getenv("STUDIO_TEST_HELLO_PACKAGE")
	if path == "" {
		t.Skip("set STUDIO_TEST_HELLO_PACKAGE to the official demo.hello 0.3.3 .piplug")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256(raw)
	if hex.EncodeToString(hash[:]) != "6c3d3fcded92d15ab78552671fcac4687e26324d8ac6ed5df5452dffb153ee4b" {
		t.Fatal("official marketplace package checksum does not match")
	}
	m := New(t.TempDir(), func() bool { return true })
	m.ConfigureHost()
	t.Cleanup(m.CloseHost)
	router := registryRouter(m)
	item := readResult[Plugin](t, uploadPlugin(t, router, raw))
	if item.Version != "0.3.3" || item.ID != "demo.hello" {
		t.Fatalf("unexpected package %s %s", item.ID, item.Version)
	}
	prefix := "/" + item.ID
	readResult[Plugin](t, requestPlugin(router, "PUT", prefix, "application/json", strings.NewReader(`{"enabled":true,"execute":true}`), true))
	run := readResult[hostResponse](t, requestPlugin(router, "POST", prefix+"/runtime/command", "application/json",
		strings.NewReader(`{"id":"hello.open"}`), true))
	if len(run.Events) != 2 || run.Events[0].ID != "panel" || run.Events[1].Text != "Hello from marketplace" {
		t.Fatalf("unexpected hello command: %#v", run)
	}
	content := readResult[map[string]string](t, requestPlugin(router, "POST", prefix+"/runtime/view", "application/json",
		strings.NewReader(`{"id":"panel"}`), true))
	if strings.Count(content["html"], "data:text/javascript;base64,") != 3 || !strings.Contains(content["html"], "data:text/css;base64,") {
		t.Fatal("official panel did not load its package scripts and style sheet")
	}
	reply, err := m.CallHostAgentTool(context.Background(), "demo.hello", "echo_text", json.RawMessage(`{"text":"Studio test"}`))
	if err != nil || !strings.Contains(string(reply), `"echo":"Studio test"`) {
		t.Fatalf("official hello tool returned %s: %v", reply, err)
	}
}
