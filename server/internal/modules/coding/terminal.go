package coding

import (
	"errors"
	"io"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

const (
	terminalMaxSessions = 12
	terminalMaxStored   = 24
	terminalMaxProject  = 2
	terminalReplayBytes = 512 << 10
	terminalIdle        = 2 * time.Minute
)

var errTerminalLimit = errors.New("已达到可打开的终端数量上限")

type terminalSize struct {
	Cols int `json:"cols"`
	Rows int `json:"rows"`
}

func (size terminalSize) valid() bool {
	return size.Cols >= 2 && size.Cols <= 500 && size.Rows >= 2 && size.Rows <= 300
}

type pseudoTerminal interface {
	io.ReadWriteCloser
	resize(terminalSize) error
	wait() int
	stop()
}

// TerminalService owns interactive shell processes for the application's lifetime.
type TerminalService struct {
	mu       sync.Mutex
	sessions map[string]*terminalSession
	closed   bool
}

func NewTerminalService() *TerminalService {
	return &TerminalService{sessions: make(map[string]*terminalSession)}
}

type terminalSession struct {
	id      string
	project string
	device  pseudoTerminal
	input   chan []byte
	done    chan struct{}

	mu       sync.Mutex
	output   []byte
	base     uint64
	changed  chan struct{}
	attached int
	idle     *time.Timer
	stopping bool
	exit     *int
}

type terminalEvent struct {
	Type   string `json:"type"`
	Data   []byte `json:"data,omitempty"`
	Cursor uint64 `json:"cursor,omitempty"`
	Code   *int   `json:"code,omitempty"`
}

func (s *TerminalService) start(project, directory string, size terminalSize) (*terminalSession, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil, errors.New("终端服务已关闭")
	}
	active, projectActive := 0, 0
	for id, session := range s.sessions {
		session.mu.Lock()
		running := session.exit == nil
		session.mu.Unlock()
		if !running {
			if len(s.sessions) >= terminalMaxStored {
				delete(s.sessions, id)
			}
			continue
		}
		active++
		if project == session.project {
			projectActive++
		}
	}
	if active >= terminalMaxSessions || projectActive >= terminalMaxProject {
		return nil, errTerminalLimit
	}
	device, err := openPseudoTerminal(directory, size)
	if err != nil {
		return nil, err
	}
	session := &terminalSession{
		id: uuid.NewString(), project: project, device: device, input: make(chan []byte, 64),
		done: make(chan struct{}), changed: make(chan struct{}),
	}
	session.startIdleTimer()
	s.sessions[session.id] = session
	go session.run(func() {
		time.AfterFunc(terminalIdle, func() {
			s.mu.Lock()
			delete(s.sessions, session.id)
			s.mu.Unlock()
		})
	})
	return session, nil
}

func (s *TerminalService) terminal(project, id string) *terminalSession {
	s.mu.Lock()
	defer s.mu.Unlock()
	session := s.sessions[id]
	if session == nil || session.project != project {
		return nil
	}
	return session
}

func (s *TerminalService) Close() {
	if s == nil {
		return
	}
	s.mu.Lock()
	s.closed = true
	sessions := s.sessions
	s.sessions = nil
	s.mu.Unlock()
	for _, session := range sessions {
		session.stop()
	}
}

func (s *terminalSession) notify() {
	close(s.changed)
	s.changed = make(chan struct{})
}

func (s *terminalSession) run(onExit func()) {
	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		var buf [16 << 10]byte
		for {
			n, err := s.device.Read(buf[:])
			if n > 0 {
				s.mu.Lock()
				if drop := len(s.output) + n - terminalReplayBytes; drop > 0 {
					copy(s.output, s.output[drop:])
					s.output = s.output[:len(s.output)-drop]
					s.base += uint64(drop)
				}
				s.output = append(s.output, buf[:n]...)
				s.notify()
				s.mu.Unlock()
			}
			if err != nil {
				return
			}
		}
	}()
	go func() {
		for {
			select {
			case data := <-s.input:
				if _, err := s.device.Write(data); err != nil {
					return
				}
			case <-s.done:
				return
			}
		}
	}()
	code := s.device.wait()
	// Give a normally exiting shell time to drain its final output. Detached descendants
	// on Unix can keep the PTY open beyond the shell's exit.
	select {
	case <-readDone:
	case <-time.After(500 * time.Millisecond):
	}
	_ = s.device.Close()
	<-readDone
	s.mu.Lock()
	if s.idle != nil {
		s.idle.Stop()
	}
	s.exit = &code
	s.notify()
	close(s.done)
	s.mu.Unlock()
	onExit()
}

func (s *terminalSession) startIdleTimer() {
	s.idle = time.AfterFunc(terminalIdle, func() {
		s.mu.Lock()
		if s.attached > 0 || s.exit != nil || s.stopping {
			s.mu.Unlock()
			return
		}
		s.stopping = true
		s.mu.Unlock()
		s.device.stop()
	})
}

func (s *terminalSession) attach() func() {
	s.mu.Lock()
	if s.idle != nil {
		s.idle.Stop()
	}
	s.attached++
	s.mu.Unlock()
	return func() {
		s.mu.Lock()
		s.attached--
		if s.attached == 0 && s.exit == nil && !s.stopping {
			s.startIdleTimer()
		}
		s.mu.Unlock()
	}
}

func (s *terminalSession) stop() {
	s.mu.Lock()
	if s.stopping || s.exit != nil {
		s.mu.Unlock()
		return
	}
	s.stopping = true
	if s.idle != nil {
		s.idle.Stop()
	}
	s.mu.Unlock()
	s.device.stop()
}

func (s *terminalSession) next(cursor uint64) (terminalEvent, <-chan struct{}) {
	s.mu.Lock()
	defer s.mu.Unlock()
	end := s.base + uint64(len(s.output))
	switch {
	case cursor < s.base || cursor > end:
		return terminalEvent{Type: "reset", Cursor: s.base}, nil
	case cursor < end:
		size := min(uint64(16<<10), end-cursor)
		start := cursor - s.base
		return terminalEvent{Type: "output", Data: append([]byte(nil), s.output[start:start+size]...), Cursor: cursor + size}, nil
	case s.exit != nil:
		return terminalEvent{Type: "exit", Code: s.exit}, nil
	default:
		return terminalEvent{}, s.changed
	}
}

func terminalEnvironment() []string {
	env := make([]string, 0, len(os.Environ())+2)
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		key = strings.ToUpper(key)
		if key == "" || key == "TERM" || key == "COLORTERM" || strings.HasPrefix(key, "STUDIO_") {
			continue
		}
		env = append(env, entry)
	}
	return append(env, "TERM=xterm-256color", "COLORTERM=truecolor")
}
