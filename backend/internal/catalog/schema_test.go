package catalog

import (
	"path/filepath"
	"runtime"
	"testing"
)

func seedDir(t *testing.T) string {
	t.Helper()
	_, file, _, _ := runtime.Caller(0)
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", "..", "data", "seed"))
}

func TestSQLiteHasNoSessionTables(t *testing.T) {
	cat, err := New(":memory:", seedDir(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cat.Close() })

	rows, err := cat.db.DB.Query(`SELECT name FROM sqlite_master WHERE type IN ('table','view')`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	forbidden := map[string]struct{}{
		"sessions": {}, "session": {}, "chat_history": {}, "conversation": {}, "turns": {},
	}
	var names []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatal(err)
		}
		names = append(names, name)
		if _, bad := forbidden[name]; bad {
			t.Fatalf("SQLite must not store sessions; found table %q", name)
		}
	}
	if len(names) == 0 {
		t.Fatal("expected catalog tables")
	}
}
