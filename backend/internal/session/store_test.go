package session

import "testing"

func TestStoreIsMemoryOnly(t *testing.T) {
	store := NewStore()
	id := store.Create("user_active")
	sess, ok := store.Get(id)
	if !ok {
		t.Fatal("session missing")
	}
	if sess.UserID != "user_active" {
		t.Fatalf("user=%s", sess.UserID)
	}
	if sess.Context.Turns != 0 {
		t.Fatalf("fresh context turns=%d", sess.Context.Turns)
	}
	id2 := store.Create("user_budget")
	if id2 == id {
		t.Fatal("session ids must be unique")
	}
	if _, ok := store.Get("missing"); ok {
		t.Fatal("missing session should not exist")
	}
	// 会话只在进程内 map；无 SQLite 句柄或持久化路径。
	if store.sessions == nil {
		t.Fatal("expected in-memory map")
	}
}
