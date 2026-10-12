package catalog

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf8"

	_ "modernc.org/sqlite"

	"github.com/ImWenyaoT/chatty/backend/internal/models"
)

var chineseCharacter = regexp.MustCompile(`[\x{4e00}-\x{9fff}]`)

const schema = `
CREATE TABLE IF NOT EXISTS products (
  product_id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents > 0), description TEXT NOT NULL,
  brand TEXT NOT NULL, seller_id TEXT NOT NULL,
  stock INTEGER NOT NULL CHECK (stock >= 0),
  tags_json TEXT NOT NULL, popularity_score REAL NOT NULL, image_url TEXT NOT NULL,
  source TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS user_profiles (
  user_id TEXT PRIMARY KEY, segment TEXT NOT NULL,
  preferred_categories_json TEXT NOT NULL,
  min_price_cents INTEGER NOT NULL CHECK (min_price_cents >= 0),
  max_price_cents INTEGER NOT NULL CHECK (max_price_cents >= min_price_cents),
  recent_views_json TEXT NOT NULL, recent_purchases_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS marketing_templates (
  segment TEXT PRIMARY KEY, tone TEXT NOT NULL, instructions TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS forbidden_words (word TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS knowledge_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
  content TEXT NOT NULL, category TEXT NOT NULL,
  product_id TEXT REFERENCES products(product_id), source TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_documents_fts USING fts5(
  doc_id UNINDEXED, chunk_ordinal UNINDEXED, title, content, raw_content UNINDEXED,
  category, product_id UNINDEXED, tokenize = 'unicode61'
);
`

type Database struct {
	DB *sql.DB
}

func OpenDatabase(path, seedDir string) (*Database, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	if _, err := db.Exec(`PRAGMA foreign_keys = ON`); err != nil {
		_ = db.Close()
		return nil, err
	}
	if _, err := db.Exec(schema); err != nil {
		_ = db.Close()
		return nil, err
	}
	d := &Database{DB: db}
	empty, err := d.isEmpty()
	if err != nil {
		_ = db.Close()
		return nil, err
	}
	if empty {
		if err := d.seed(seedDir); err != nil {
			_ = db.Close()
			return nil, err
		}
	}
	return d, nil
}

func (d *Database) Close() error {
	return d.DB.Close()
}

func (d *Database) isEmpty() (bool, error) {
	var count int
	err := d.DB.QueryRow(`SELECT COUNT(*) FROM products`).Scan(&count)
	return count == 0, err
}

func SegmentForIndex(text string) string {
	return chineseCharacter.ReplaceAllStringFunc(text, func(c string) string {
		return " " + c + " "
	})
}

func SplitIntoChunks(text string, target, overlap int) []string {
	normalized := strings.TrimSpace(text)
	if normalized == "" {
		return nil
	}
	if utf8.RuneCountInString(normalized) <= target {
		return []string{normalized}
	}
	parts := splitSentences(normalized)
	var chunks []string
	var current string
	for _, sentence := range parts {
		if sentence == "" {
			continue
		}
		if current == "" || utf8.RuneCountInString(current)+utf8.RuneCountInString(sentence) <= target {
			current += sentence
			continue
		}
		chunks = append(chunks, strings.TrimSpace(current))
		prefix := ""
		if overlap > 0 {
			runes := []rune(current)
			if len(runes) > overlap {
				prefix = string(runes[len(runes)-overlap:])
			} else {
				prefix = current
			}
		}
		current = prefix + sentence
	}
	if strings.TrimSpace(current) != "" {
		chunks = append(chunks, strings.TrimSpace(current))
	}
	return chunks
}

// splitSentences 在中文句末标点后切开，并保留标点（等价于 JS 的 lookbehind split）。
func splitSentences(text string) []string {
	var parts []string
	var b strings.Builder
	for _, r := range text {
		b.WriteRune(r)
		if r == '。' || r == '！' || r == '？' || r == '；' {
			parts = append(parts, b.String())
			b.Reset()
		}
	}
	if b.Len() > 0 {
		parts = append(parts, b.String())
	}
	return parts
}

func (d *Database) seed(seedDir string) error {
	products, err := readJSONL[productSeed](filepath.Join(seedDir, "products.jsonl"))
	if err != nil {
		return err
	}
	profiles, err := readJSONL[profileSeed](filepath.Join(seedDir, "user_profiles.jsonl"))
	if err != nil {
		return err
	}
	docs, err := readJSONL[docSeed](filepath.Join(seedDir, "knowledge_documents.jsonl"))
	if err != nil {
		return err
	}
	templatesRaw, err := os.ReadFile(filepath.Join(seedDir, "marketing_templates.json"))
	if err != nil {
		return err
	}
	var templates map[string]struct {
		Tone         string `json:"tone"`
		Instructions string `json:"instructions"`
	}
	if err := json.Unmarshal(templatesRaw, &templates); err != nil {
		return err
	}
	forbiddenRaw, err := os.ReadFile(filepath.Join(seedDir, "forbidden_words.json"))
	if err != nil {
		return err
	}
	var forbidden []string
	if err := json.Unmarshal(forbiddenRaw, &forbidden); err != nil {
		return err
	}

	tx, err := d.DB.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	for _, p := range products {
		tags, _ := json.Marshal(p.Tags)
		_, err := tx.Exec(
			`INSERT INTO products VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
			p.ProductID, p.Name, p.Category, p.PriceCents, p.Description,
			p.Brand, p.SellerID, p.Stock, string(tags), p.PopularityScore, p.ImageURL, p.Source,
		)
		if err != nil {
			return fmt.Errorf("seed product %s: %w", p.ProductID, err)
		}
	}
	for _, p := range profiles {
		cats, _ := json.Marshal(p.PreferredCategories)
		views, _ := json.Marshal(p.RecentViews)
		purchases, _ := json.Marshal(p.RecentPurchases)
		_, err := tx.Exec(
			`INSERT INTO user_profiles VALUES (?,?,?,?,?,?,?)`,
			p.UserID, p.Segment, string(cats), p.MinPriceCents, p.MaxPriceCents, string(views), string(purchases),
		)
		if err != nil {
			return fmt.Errorf("seed profile %s: %w", p.UserID, err)
		}
	}
	for segment, t := range templates {
		if strings.HasPrefix(segment, "_") {
			continue
		}
		_, err := tx.Exec(`INSERT INTO marketing_templates VALUES (?,?,?)`, segment, t.Tone, t.Instructions)
		if err != nil {
			return err
		}
	}
	for _, w := range forbidden {
		if _, err := tx.Exec(`INSERT INTO forbidden_words VALUES (?)`, w); err != nil {
			return err
		}
	}
	for _, doc := range docs {
		var productID any
		if doc.ProductID != nil {
			productID = *doc.ProductID
		}
		_, err := tx.Exec(
			`INSERT INTO knowledge_documents (doc_id, title, content, category, product_id, source) VALUES (?,?,?,?,?,?)`,
			doc.DocID, doc.Title, doc.Content, doc.Category, productID, doc.Source,
		)
		if err != nil {
			return fmt.Errorf("seed doc %s: %w", doc.DocID, err)
		}
		chunks := SplitIntoChunks(doc.Content, 160, 40)
		for i, chunk := range chunks {
			indexedTitle := SegmentForIndex(doc.Title)
			indexedContent := SegmentForIndex(chunk)
			pid := ""
			if doc.ProductID != nil {
				pid = *doc.ProductID
			}
			_, err := tx.Exec(
				`INSERT INTO knowledge_documents_fts (doc_id, chunk_ordinal, title, content, raw_content, category, product_id)
				 VALUES (?,?,?,?,?,?,?)`,
				doc.DocID, i, indexedTitle, indexedContent, chunk, doc.Category, pid,
			)
			if err != nil {
				return err
			}
		}
	}
	return tx.Commit()
}

type productSeed struct {
	ProductID       string   `json:"product_id"`
	Name            string   `json:"name"`
	Category        string   `json:"category"`
	PriceCents      int      `json:"price_cents"`
	Description     string   `json:"description"`
	Brand           string   `json:"brand"`
	SellerID        string   `json:"seller_id"`
	Stock           int      `json:"stock"`
	Tags            []string `json:"tags"`
	PopularityScore float64  `json:"popularity_score"`
	ImageURL        string   `json:"image_url"`
	Source          string   `json:"source"`
}

type profileSeed struct {
	UserID              string             `json:"user_id"`
	Segment             models.UserSegment `json:"segment"`
	PreferredCategories []string           `json:"preferred_categories"`
	MinPriceCents       int                `json:"min_price_cents"`
	MaxPriceCents       int                `json:"max_price_cents"`
	RecentViews         []string           `json:"recent_views"`
	RecentPurchases     []string           `json:"recent_purchases"`
}

type docSeed struct {
	DocID     string  `json:"doc_id"`
	Title     string  `json:"title"`
	Content   string  `json:"content"`
	Category  string  `json:"category"`
	ProductID *string `json:"product_id"`
	Source    string  `json:"source"`
}

func readJSONL[T any](path string) ([]T, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var out []T
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var item T
		if err := json.Unmarshal([]byte(line), &item); err != nil {
			return nil, fmt.Errorf("%s: %w", path, err)
		}
		out = append(out, item)
	}
	return out, nil
}
