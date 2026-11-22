package coding

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"server/internal/config"
	"server/internal/model"
	"server/internal/modules/piplugins"
)

type runtimeEvent struct {
	Type string `json:"type"`
	Text string `json:"text,omitempty"`
	Name string `json:"name,omitempty"`
	Path string `json:"path,omitempty"`
}

func (m *Module) runtimePaths() (string, string, error) {
	node, err := exec.LookPath("node")
	if err != nil {
		return "", "", errors.New("请安装 Node.js 22.19+ 后重试")
	}
	dir, err := filepath.Abs(m.RuntimeDir)
	if err != nil {
		return "", "", err
	}
	for _, file := range []string{"worker.mjs", "node_modules/@earendil-works/pi-coding-agent/package.json"} {
		if _, err := os.Stat(filepath.Join(dir, file)); err != nil {
			return "", "", errors.New("Pi 运行时待安装，请在 pi-runtime 目录运行 npm ci --ignore-scripts")
		}
	}
	return node, dir, nil
}

func (m *Module) runPi(ctx context.Context, root *os.Root, cfg config.LLM, projectID, sessionID, mode, prompt string, enhancements model.CodingEnhancements, emit func(runtimeEvent) error) error {
	node, dir, err := m.runtimePaths()
	if err != nil {
		return err
	}
	stateDir, err := filepath.Abs(m.StateDir)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(stateDir, 0700); err != nil {
		return err
	}
	if cfg.Provider == "ollama" {
		_, cfg.BaseURL, err = config.OllamaEndpoints(cfg.BaseURL)
		if err != nil {
			return err
		}
	}
	if cfg.Provider == "ollama" || cfg.Provider == "lmstudio" && cfg.APIKey == "" {
		cfg.APIKey = "local"
	}
	cfg.BaseURL = strings.TrimRight(cfg.BaseURL, "/")
	var plugins pluginRuntimeConfig
	var hostTools []piplugins.HostAgentTool
	var trustedExtensions []string
	delegated := delegatedContext(ctx)
	if !delegated {
		plugins, err = loadPluginRuntime(ctx, m.Plugins)
		if err != nil {
			return err
		}
		if mode == "agent" && m.Plugins != nil {
			hostTools = m.Plugins.HostAgentTools(ctx)
			paths, cleanup, err := m.Plugins.StageTrustedExtensions(ctx)
			if err != nil {
				return err
			}
			defer cleanup()
			trustedExtensions = paths
		}
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	cmd := exec.CommandContext(ctx, node, filepath.Join(dir, "worker.mjs"))
	cmd.Dir = dir
	hideWindow(cmd)
	input, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	// EOF gives Pi time to stop any stdio MCP process before Go kills the worker.
	cmd.Cancel = input.Close
	cmd.WaitDelay = 5 * time.Second
	defer input.Close()
	output, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	defer func() {
		cancel()
		_ = cmd.Wait()
	}()
	writer := json.NewEncoder(input)
	var orchestration *orchestrationToolCatalog
	if mode == "agent" && !delegated {
		orchestration = m.orchestrationCatalog(ctx, sessionID)
	}
	if err := writer.Encode(map[string]any{
		"model": cfg, "prompt": prompt, "mode": mode, "session_file": filepath.Join(stateDir, sessionID+".jsonl"),
		"project_instructions": projectInstructions(root, "."),
		"global_instruction":   globalInstruction(stateDir),
		"plugins":              plugins,
		"host_tools":           hostTools,
		"trusted_extensions":   trustedExtensions,
		"project_path":         root.Name(),
		"orchestration":        orchestration,
		"coding_memory":        map[string]bool{"recall": enhancements.Recall, "write": enhancements.MemoryWrite},
	}); err != nil {
		return err
	}
	scanner := bufio.NewScanner(output)
	scanner.Buffer(make([]byte, 32<<10), 2<<20)
	toolCount := 0
	for scanner.Scan() {
		if err := ctx.Err(); err != nil {
			return err
		}
		var event struct {
			runtimeEvent
			Args json.RawMessage `json:"args"`
		}
		if json.Unmarshal(scanner.Bytes(), &event) != nil {
			continue
		}
		switch event.Type {
		case "delta":
			if err := emit(event.runtimeEvent); err != nil {
				return err
			}
		case "plugin_tool":
			event.Type = "tool"
			if err := emit(event.runtimeEvent); err != nil {
				return err
			}
		case "tool":
			toolCount++
			if toolCount > 40 {
				return errors.New("本轮文件操作已达上限，请分步继续")
			}
			var args struct {
				Path      string          `json:"path"`
				Action    string          `json:"action"`
				Scope     string          `json:"scope"`
				Query     string          `json:"query"`
				Plugin    string          `json:"plugin"`
				Tool      string          `json:"tool"`
				Agent     string          `json:"agent"`
				Arguments json.RawMessage `json:"arguments"`
				fileContent
			}
			err := json.Unmarshal(event.Args, &args)
			var data any
			if err == nil {
				if event.Name == "coding_memory" {
					args.Path = args.Action
				} else if event.Name == "plugin_action" {
					args.Path = args.Plugin + "/" + args.Tool
				} else if event.Name == "delegate_task" {
					args.Path = args.Agent
				} else if event.Name == "session_task" {
					args.Path = args.Action
				}
				if err := emit(runtimeEvent{Type: "tool", Name: event.Name, Path: args.Path}); err != nil {
					return err
				}
				if err := ctx.Err(); err != nil {
					return err
				}
				switch {
				case event.Name == "list_files":
					data, err = listFiles(root, args.Path)
				case event.Name == "read_file":
					data, err = readFile(root, args.Path)
				case event.Name == "project_instructions":
					data, err = workspaceInstructions(root, args.Path)
				case event.Name == "coding_memory":
					data, err = m.codingMemoryTool(projectID, mode, args.Action, args.Scope, args.Query, args.Content, enhancements)
				case !delegated && mode == "agent" && (event.Name == "delegate_task" || event.Name == "session_task"):
					data, err = m.runOrchestrationTool(ctx, projectID, sessionID, event.Name, event.Args)
				case !delegated && mode == "agent" && event.Name == "plugin_action" && m.Plugins != nil:
					workspace := piplugins.WithHostWorkspace(ctx, piplugins.HostWorkspaceContext{ProjectID: projectID, SessionID: sessionID})
					data, err = m.Plugins.CallHostAgentTool(workspace, args.Plugin, args.Tool, args.Arguments)
				case event.Name == "write_file" && mode == "agent":
					data, err = m.writeFile(root, args.Path, args.fileContent)
					if err == nil {
						data = map[string]string{"path": args.Path, "revision": data.(fileContent).Revision}
						if err := emit(runtimeEvent{Type: "changed", Path: args.Path}); err != nil {
							return err
						}
					}
				default:
					err = errors.New("此模式不支持该工具")
				}
			}
			reply := map[string]any{"data": data}
			if err != nil {
				reply["error"] = err.Error()
			}
			if err := writer.Encode(reply); err != nil {
				return err
			}
		case "error":
			message := event.Text
			if cfg.APIKey != "" {
				message = strings.ReplaceAll(message, cfg.APIKey, "[redacted]")
			}
			return errors.New(message)
		case "done":
			return nil
		}
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return errors.New("Pi 运行时未完成本轮生成，请确认 Node.js 版本及运行时依赖")
}
