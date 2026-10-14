package agent

import (
	"os"
	"path/filepath"
)

func readPromptFile(promptsDir, name string) (string, error) {
	b, err := os.ReadFile(filepath.Join(promptsDir, name))
	if err != nil {
		return "", err
	}
	return string(b), nil
}
