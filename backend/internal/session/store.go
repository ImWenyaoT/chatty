package session

import (
	"crypto/rand"
	"encoding/hex"
	"sync"

	"github.com/ImWenyaoT/chatty/backend/internal/agent"
)

type Session struct {
	ID     string
	UserID string
	Context agent.ChattyContext
	mu     sync.Mutex
}

type Store struct {
	mu       sync.Mutex
	sessions map[string]*Session
}

func NewStore() *Store {
	return &Store{sessions: map[string]*Session{}}
}

func (s *Store) Create(userID string) string {
	id := newID()
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sessions[id] = &Session{
		ID:      id,
		UserID:  userID,
		Context: agent.NewChattyContext(),
	}
	return id
}

func (s *Store) Get(id string) (*Session, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	sess, ok := s.sessions[id]
	return sess, ok
}

func (s *Session) RunExclusive(fn func(*Session) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return fn(s)
}

func newID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}
