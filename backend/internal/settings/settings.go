package settings

import (
	"bufio"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type Settings struct {
	APIKey  string
	BaseURL string
	Model   string
	Port    int
	SeedDir string
}

func Load(repoRoot string) Settings {
	values := map[string]string{}
	for k, v := range envMap() {
		values[k] = v
	}
	mergeEnvFile(values, filepath.Join(repoRoot, ".env"))
	mergeEnvFile(values, filepath.Join(repoRoot, ".env.local"))

	s := Settings{
		APIKey:  first(values, "DEEPSEEK_API_KEY", "OPENAI_API_KEY"),
		BaseURL: first(values, "DEEPSEEK_BASE_URL", "OPENAI_BASE_URL"),
		Model:   first(values, "DEEPSEEK_MODEL", "MODEL_ID"),
		Port:    8000,
		SeedDir: filepath.Join(repoRoot, "data", "seed"),
	}
	if s.BaseURL == "" {
		s.BaseURL = "https://api.deepseek.com"
	}
	if s.Model == "" {
		s.Model = "deepseek-v4-flash"
	}
	if p := first(values, "PORT"); p != "" {
		if n, err := strconv.Atoi(p); err == nil {
			s.Port = n
		}
	}
	return s
}

func (s Settings) Configured() bool {
	return strings.TrimSpace(s.APIKey) != ""
}

func envMap() map[string]string {
	out := map[string]string{}
	for _, e := range os.Environ() {
		k, v, ok := strings.Cut(e, "=")
		if ok {
			out[k] = v
		}
	}
	return out
}

func mergeEnvFile(dst map[string]string, path string) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		k = strings.TrimSpace(k)
		v = strings.TrimSpace(v)
		v = strings.Trim(v, `"'`)
		if k != "" {
			dst[k] = v
		}
	}
}

func first(m map[string]string, keys ...string) string {
	for _, k := range keys {
		if v := strings.TrimSpace(m[k]); v != "" {
			return v
		}
	}
	return ""
}
