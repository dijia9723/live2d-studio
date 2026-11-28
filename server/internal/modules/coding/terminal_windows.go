//go:build windows

// terminal_windows.go 基于 ConPTY 实现 Windows 交互终端。
package coding

import (
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"
)

var terminalKernel = windows.NewLazySystemDLL("kernel32.dll")

type windowsTerminal struct {
	input, output *os.File
	process       windows.Handle
	job           windows.Handle
	console       windows.Handle
	mu            sync.Mutex
}

func openPseudoTerminal(directory string, size terminalSize) (pseudoTerminal, error) {
	if err := terminalKernel.NewProc("CreatePseudoConsole").Find(); err != nil {
		return nil, errors.New("系统未提供 ConPTY")
	}
	systemDir, err := windows.GetSystemDirectory()
	if err != nil {
		return nil, err
	}
	shell := filepath.Join(systemDir, "WindowsPowerShell", "v1.0", "powershell.exe")
	args := []string{shell, "-NoLogo", "-NoProfile"}
	if _, err := os.Stat(shell); err != nil {
		shell = filepath.Join(systemDir, "cmd.exe")
		args = []string{shell, "/D"}
	}
	exe, err := windows.UTF16PtrFromString(shell)
	if err != nil {
		return nil, err
	}
	command, err := windows.UTF16PtrFromString(windows.ComposeCommandLine(args))
	if err != nil {
		return nil, err
	}
	cwd, err := windows.UTF16PtrFromString(directory)
	if err != nil {
		return nil, err
	}
	inputReader, input, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	defer inputReader.Close()
	output, outputWriter, err := os.Pipe()
	if err != nil {
		input.Close()
		return nil, err
	}
	defer outputWriter.Close()
	t := &windowsTerminal{input: input, output: output}
	started := false
	defer func() {
		if !started {
			_ = t.Close()
			t.stop()
			t.release()
		}
	}()
	if err := windows.CreatePseudoConsole(
		windows.Coord{X: int16(size.Cols), Y: int16(size.Rows)},
		windows.Handle(inputReader.Fd()), windows.Handle(outputWriter.Fd()), 0, &t.console,
	); err != nil {
		return nil, err
	}
	t.job, err = windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, err
	}
	limits := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	// 把子进程放入 job 并设置随 job 关闭而终止，确保 Studio 退出时不会遗留 shell 进程树。
	limits.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(t.job, windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits))); err != nil {
		return nil, err
	}
	attributes, err := windows.NewProcThreadAttributeList(1)
	if err != nil {
		return nil, err
	}
	defer attributes.Delete()
	// 该属性的值直接是控制台句柄本身，而不是指向存储的地址，与其他进程属性不同。
	setAttribute := terminalKernel.NewProc("UpdateProcThreadAttribute")
	result, _, callErr := setAttribute.Call(uintptr(unsafe.Pointer(attributes.List())), 0,
		windows.PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, uintptr(t.console), unsafe.Sizeof(t.console), 0, 0)
	if result == 0 {
		return nil, callErr
	}
	info := windows.StartupInfoEx{
		StartupInfo: windows.StartupInfo{
			Cb: uint32(unsafe.Sizeof(windows.StartupInfoEx{})),
			// 不要把宿主进程重定向后的标准句柄复制进这个新控制台。
			Flags: windows.STARTF_USESTDHANDLES,
		},
		ProcThreadAttributeList: attributes.List(),
	}
	env := terminalEnvironment()
	slices.SortFunc(env, func(a, b string) int { return strings.Compare(strings.ToUpper(a), strings.ToUpper(b)) })
	envBlock := utf16.Encode([]rune(strings.Join(env, "\x00") + "\x00\x00"))
	var process windows.ProcessInformation
	flags := uint32(windows.EXTENDED_STARTUPINFO_PRESENT | windows.CREATE_UNICODE_ENVIRONMENT | windows.CREATE_SUSPENDED)
	if err := windows.CreateProcess(exe, command, nil, nil, false, flags, &envBlock[0], cwd, &info.StartupInfo, &process); err != nil {
		return nil, err
	}
	t.process = process.Process
	defer windows.CloseHandle(process.Thread)
	if err := windows.AssignProcessToJobObject(t.job, process.Process); err != nil {
		_ = windows.TerminateProcess(process.Process, 1)
		return nil, err
	}
	if _, err := windows.ResumeThread(process.Thread); err != nil {
		return nil, err
	}
	started = true
	return t, nil
}

// Read 从 ConPTY 的输出管道读取终端输出。
func (t *windowsTerminal) Read(data []byte) (int, error) { return t.output.Read(data) }

// Write 把用户输入写入 ConPTY 的输入管道。
func (t *windowsTerminal) Write(data []byte) (int, error) { return t.input.Write(data) }

// Close 关闭伪终端的输入与输出管道。
func (t *windowsTerminal) Close() error { return errors.Join(t.input.Close(), t.output.Close()) }

func (t *windowsTerminal) resize(size terminalSize) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.console == 0 {
		return os.ErrClosed
	}
	return windows.ResizePseudoConsole(t.console, windows.Coord{X: int16(size.Cols), Y: int16(size.Rows)})
}

func (t *windowsTerminal) stop() {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.job != 0 {
		_ = windows.TerminateJobObject(t.job, 1)
	}
}

func (t *windowsTerminal) wait() int {
	result, err := windows.WaitForSingleObject(t.process, windows.INFINITE)
	var code uint32
	if err == nil && result == windows.WAIT_OBJECT_0 {
		err = windows.GetExitCodeProcess(t.process, &code)
	} else if err == nil {
		err = errors.New("终端进程等待失败")
	}
	t.release()
	if err != nil {
		return -1
	}
	return int(code)
}

func (t *windowsTerminal) release() {
	t.mu.Lock()
	console, job, process := t.console, t.job, t.process
	t.console, t.job, t.process = 0, 0, 0
	t.mu.Unlock()
	if job != 0 {
		_ = windows.CloseHandle(job)
	}
	if process != 0 {
		_ = windows.CloseHandle(process)
	}
	if console != 0 {
		// 终端服务已在拆除流程中独立排空输出，这里只负责释放控制台句柄。
		windows.ClosePseudoConsole(console)
	}
}
