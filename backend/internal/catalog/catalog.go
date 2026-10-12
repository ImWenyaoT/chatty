package catalog

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/ImWenyaoT/chatty/backend/internal/models"
)

type Error string

func (e Error) Error() string { return string(e) }

type Catalog struct {
	Products       []models.Product
	Profiles       map[string]models.UserProfile
	ForbiddenWords []string
	Categories     []string

	db        *Database
	templates map[string]models.MarketingStrategy
	synonyms  map[string][]string
}

func New(dbPath, seedDir string) (*Catalog, error) {
	db, err := OpenDatabase(dbPath, seedDir)
	if err != nil {
		return nil, err
	}
	c := &Catalog{db: db, Profiles: map[string]models.UserProfile{}, templates: map[string]models.MarketingStrategy{}}
	if err := c.reload(); err != nil {
		_ = db.Close()
		return nil, err
	}
	syn, err := loadSynonyms(filepath.Join(seedDir, "query_synonyms.json"))
	if err != nil {
		_ = db.Close()
		return nil, err
	}
	c.synonyms = syn
	return c, nil
}

func (c *Catalog) Close() error { return c.db.Close() }

func (c *Catalog) reload() error {
	products, err := c.listProducts()
	if err != nil {
		return err
	}
	c.Products = products
	profiles, err := c.loadProfiles()
	if err != nil {
		return err
	}
	c.Profiles = profiles
	words, err := c.loadForbiddenWords()
	if err != nil {
		return err
	}
	c.ForbiddenWords = words
	templates, err := c.loadMarketingTemplates()
	if err != nil {
		return err
	}
	c.templates = templates
	cats := map[string]struct{}{}
	for _, p := range products {
		cats[p.Category] = struct{}{}
	}
	c.Categories = make([]string, 0, len(cats))
	for cat := range cats {
		c.Categories = append(c.Categories, cat)
	}
	sort.Strings(c.Categories)
	return nil
}

func (c *Catalog) maxProductPriceCents() int {
	max := 0
	for _, p := range c.Products {
		if p.PriceCents > max {
			max = p.PriceCents
		}
	}
	return max
}

func (c *Catalog) UserProfile(userID string, overrides models.UserContext) (models.UserProfile, error) {
	base, ok := c.Profiles[userID]
	if !ok {
		return models.UserProfile{}, Error("unknown_user")
	}
	preferred := base.PreferredCategories
	if len(overrides.PreferredCategories) > 0 {
		preferred = overrides.PreferredCategories
	}
	minPrice := overrides.MinPriceCents
	var minPriceCents int
	if minPrice == nil {
		if overrides.MaxPriceCents == nil {
			minPriceCents = base.MinPriceCents
		} else {
			minPriceCents = 0
		}
	} else {
		minPriceCents = *minPrice
	}
	maxPrice := overrides.MaxPriceCents
	var maxPriceCents int
	if maxPrice == nil {
		if overrides.MinPriceCents == nil {
			maxPriceCents = base.MaxPriceCents
		} else {
			maxPriceCents = c.maxProductPriceCents()
			if overrides.MinPriceCents != nil && *overrides.MinPriceCents > maxPriceCents {
				maxPriceCents = *overrides.MinPriceCents
			}
		}
	} else {
		maxPriceCents = *maxPrice
	}
	views := base.RecentViews
	if len(overrides.RecentViews) > 0 {
		views = overrides.RecentViews
	}
	purchases := base.RecentPurchases
	if len(overrides.RecentPurchases) > 0 {
		purchases = overrides.RecentPurchases
	}
	return models.UserProfile{
		UserID:              base.UserID,
		Segment:             base.Segment,
		PreferredCategories: preferred,
		MinPriceCents:       minPriceCents,
		MaxPriceCents:       maxPriceCents,
		RecentViews:         views,
		RecentPurchases:     purchases,
	}, nil
}

func (c *Catalog) Search(profile models.UserProfile, categories []string, minPriceCents, maxPriceCents, limit int) ([]models.Product, error) {
	if minPriceCents < 0 || maxPriceCents <= 0 || minPriceCents > maxPriceCents {
		return nil, Error("invalid_product_search_price_range")
	}
	if limit < 1 || limit > 20 {
		return nil, Error("invalid_product_search_limit")
	}
	normalized := normalize(categories)
	if len(categories) > 0 && len(normalized) == 0 {
		return nil, Error("invalid_product_search_categories")
	}
	type scored struct {
		product models.Product
		score   float64
	}
	var matches []scored
	for _, product := range c.Products {
		inside := product.PriceCents >= minPriceCents && product.PriceCents <= maxPriceCents
		matchCat := len(normalized) == 0 || normalized[strings.ToLower(product.Category)]
		if inside && matchCat {
			matches = append(matches, scored{product: product, score: c.score(product, profile)})
		}
	}
	sort.SliceStable(matches, func(i, j int) bool { return matches[i].score > matches[j].score })
	if len(matches) > limit {
		matches = matches[:limit]
	}
	out := make([]models.Product, len(matches))
	for i, m := range matches {
		out[i] = m.product
	}
	return out, nil
}

func (c *Catalog) Inventory(productIDs []string) ([]models.Product, error) {
	current, err := c.listProducts()
	if err != nil {
		return nil, err
	}
	byID := map[string]models.Product{}
	for _, p := range current {
		byID[p.ProductID] = p
	}
	var unknown []string
	seenUnknown := map[string]struct{}{}
	for _, id := range productIDs {
		if _, ok := byID[id]; !ok {
			if _, seen := seenUnknown[id]; !seen {
				unknown = append(unknown, id)
				seenUnknown[id] = struct{}{}
			}
		}
	}
	sort.Strings(unknown)
	if len(unknown) > 0 {
		return nil, Error(fmt.Sprintf("unknown_inventory_product:%s", strings.Join(unknown, ",")))
	}
	var available []models.Product
	seen := map[string]struct{}{}
	for _, id := range productIDs {
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		if p, ok := byID[id]; ok && p.Stock > 0 {
			available = append(available, p)
		}
	}
	return available, nil
}

func (c *Catalog) RetrieveKnowledge(query string, categories, productIDs []string, limit int) ([]models.KnowledgeHit, error) {
	if limit < 1 || limit > 8 {
		return nil, Error("invalid_knowledge_limit")
	}
	combined := strings.Join(append(append([]string{}, categories...), query), " ")
	expression := MatchExpression(c.rewriteQuery(combined))
	if expression == "" {
		return nil, Error("empty_knowledge_query")
	}
	filters := []string{}
	args := []any{expression}
	if len(categories) > 0 {
		ph := make([]string, len(categories))
		for i, cat := range categories {
			ph[i] = "?"
			args = append(args, cat)
		}
		filters = append(filters, fmt.Sprintf("f.category IN (%s)", strings.Join(ph, ",")))
	}
	if len(productIDs) > 0 {
		ph := make([]string, len(productIDs))
		for i, id := range productIDs {
			ph[i] = "?"
			args = append(args, id)
		}
		filters = append(filters, fmt.Sprintf("(f.product_id IN (%s) OR f.product_id IS NULL OR f.product_id = '')", strings.Join(ph, ",")))
	}
	filterSQL := ""
	if len(filters) > 0 {
		filterSQL = " AND " + strings.Join(filters, " AND ")
	}
	args = append(args, limit)
	rows, err := c.db.DB.Query(`
		SELECT d.doc_id, d.title, f.chunk_ordinal,
		       f.raw_content AS content, d.category, d.product_id,
		       d.source, bm25(knowledge_documents_fts) AS rank
		FROM knowledge_documents_fts AS f
		JOIN knowledge_documents AS d ON d.doc_id = f.doc_id
		WHERE knowledge_documents_fts MATCH ?`+filterSQL+`
		ORDER BY rank, f.rowid
		LIMIT ?`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var hits []models.KnowledgeHit
	for rows.Next() {
		var hit models.KnowledgeHit
		var productID sql.NullString
		var rank float64
		if err := rows.Scan(&hit.DocID, &hit.Title, &hit.ChunkOrdinal, &hit.Content, &hit.Category, &productID, &hit.Source, &rank); err != nil {
			return nil, err
		}
		if productID.Valid && productID.String != "" {
			pid := productID.String
			hit.ProductID = &pid
		}
		hit.RelevanceScore = round(1/(1+math.Abs(rank)), 4)
		hits = append(hits, hit)
	}
	return hits, rows.Err()
}

func (c *Catalog) MarketingStrategy(segment string) (models.MarketingStrategy, error) {
	s, ok := c.templates[segment]
	if !ok {
		return models.MarketingStrategy{}, Error("unknown_marketing_segment")
	}
	return s, nil
}

func (c *Catalog) Finalize(draft []models.RecommendationDraftItem, request models.RecommendationRequest, profile models.UserProfile) ([]models.RecommendedProduct, error) {
	current, err := c.listProducts()
	if err != nil {
		return nil, err
	}
	byID := map[string]models.Product{}
	for _, p := range current {
		byID[p.ProductID] = p
	}
	var recommendations []models.RecommendedProduct
	seen := map[string]struct{}{}
	for _, item := range draft {
		if _, ok := seen[item.ProductID]; ok {
			return nil, Error("duplicate_recommended_product")
		}
		product, ok := byID[item.ProductID]
		if !ok {
			return nil, Error("unknown_recommended_product")
		}
		seen[item.ProductID] = struct{}{}
		if product.Stock <= 0 {
			return nil, Error("recommended_product_out_of_stock")
		}
		if product.PriceCents < profile.MinPriceCents || product.PriceCents > profile.MaxPriceCents {
			return nil, Error("recommended_product_outside_price_range")
		}
		recommendations = append(recommendations, models.RecommendedProduct{
			ProductID:     product.ProductID,
			Name:          product.Name,
			Category:      product.Category,
			PriceCents:    product.PriceCents,
			Brand:         product.Brand,
			Stock:         product.Stock,
			Tags:          product.Tags,
			LowStock:      product.Stock <= 100,
			Reason:        c.sanitize(item.Reason),
			MarketingCopy: c.sanitize(item.MarketingCopy),
		})
		if len(recommendations) >= request.NumItems {
			break
		}
	}
	if len(recommendations) == 0 {
		return nil, Error("no_available_recommendations")
	}
	return recommendations, nil
}

func (c *Catalog) UpdateUserProfileAfterSuccess(userID string, categories []string) error {
	profile, ok := c.Profiles[userID]
	if !ok {
		return nil
	}
	var preferred []string
	seen := map[string]struct{}{}
	for _, cat := range categories {
		cat = strings.TrimSpace(cat)
		if cat == "" {
			continue
		}
		if _, ok := seen[cat]; ok {
			continue
		}
		preferred = append(preferred, cat)
		seen[cat] = struct{}{}
	}
	if len(preferred) == 0 {
		return nil
	}
	raw, _ := json.Marshal(preferred)
	_, err := c.db.DB.Exec(`UPDATE user_profiles SET preferred_categories_json = ? WHERE user_id = ?`, string(raw), userID)
	if err != nil {
		return err
	}
	profile.PreferredCategories = preferred
	c.Profiles[userID] = profile
	return nil
}

func (c *Catalog) listProducts() ([]models.Product, error) {
	rows, err := c.db.DB.Query(`SELECT product_id, name, category, price_cents, description, brand, seller_id, stock, tags_json, popularity_score, image_url, source FROM products ORDER BY product_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []models.Product
	for rows.Next() {
		var p models.Product
		var tagsJSON string
		if err := rows.Scan(&p.ProductID, &p.Name, &p.Category, &p.PriceCents, &p.Description, &p.Brand, &p.SellerID, &p.Stock, &tagsJSON, &p.PopularityScore, &p.ImageURL, &p.Source); err != nil {
			return nil, err
		}
		_ = json.Unmarshal([]byte(tagsJSON), &p.Tags)
		if p.Tags == nil {
			p.Tags = []string{}
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (c *Catalog) loadProfiles() (map[string]models.UserProfile, error) {
	rows, err := c.db.DB.Query(`SELECT user_id, segment, preferred_categories_json, min_price_cents, max_price_cents, recent_views_json, recent_purchases_json FROM user_profiles ORDER BY user_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]models.UserProfile{}
	for rows.Next() {
		var p models.UserProfile
		var cats, views, purchases string
		if err := rows.Scan(&p.UserID, &p.Segment, &cats, &p.MinPriceCents, &p.MaxPriceCents, &views, &purchases); err != nil {
			return nil, err
		}
		_ = json.Unmarshal([]byte(cats), &p.PreferredCategories)
		_ = json.Unmarshal([]byte(views), &p.RecentViews)
		_ = json.Unmarshal([]byte(purchases), &p.RecentPurchases)
		out[p.UserID] = p
	}
	return out, rows.Err()
}

func (c *Catalog) loadForbiddenWords() ([]string, error) {
	rows, err := c.db.DB.Query(`SELECT word FROM forbidden_words ORDER BY rowid`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var w string
		if err := rows.Scan(&w); err != nil {
			return nil, err
		}
		out = append(out, w)
	}
	return out, rows.Err()
}

func (c *Catalog) loadMarketingTemplates() (map[string]models.MarketingStrategy, error) {
	rows, err := c.db.DB.Query(`SELECT segment, tone, instructions FROM marketing_templates`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]models.MarketingStrategy{}
	for rows.Next() {
		var s models.MarketingStrategy
		if err := rows.Scan(&s.Segment, &s.Tone, &s.Instructions); err != nil {
			return nil, err
		}
		s.ForbiddenWords = c.ForbiddenWords
		out[string(s.Segment)] = s
	}
	return out, rows.Err()
}

func (c *Catalog) score(product models.Product, profile models.UserProfile) float64 {
	preferred := normalize(profile.PreferredCategories)
	signals := normalize(append(append([]string{}, profile.RecentViews...), profile.RecentPurchases...))
	searchable := normalize(append([]string{product.Name, product.Category}, product.Tags...))
	score := product.PopularityScore * 0.55
	if preferred[strings.ToLower(product.Category)] {
		score += 0.25
	}
	for signal := range signals {
		if searchable[signal] {
			score += 0.15
			break
		}
	}
	if product.PriceCents >= profile.MinPriceCents && product.PriceCents <= profile.MaxPriceCents {
		score += 0.05
	}
	return round(math.Min(score, 1), 4)
}

func (c *Catalog) sanitize(text string) string {
	for _, word := range c.ForbiddenWords {
		text = strings.ReplaceAll(text, word, "***")
	}
	return text
}

func loadSynonyms(path string) (map[string][]string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var obj map[string]any
	if err := json.Unmarshal(raw, &obj); err != nil {
		return nil, err
	}
	reversed := map[string][]string{}
	for canonical, variants := range obj {
		if strings.HasPrefix(canonical, "_") {
			continue
		}
		arr, ok := variants.([]any)
		if !ok {
			return nil, Error("invalid_query_synonym_variants")
		}
		for _, v := range arr {
			variant, ok := v.(string)
			if !ok {
				return nil, Error("invalid_query_synonym_variant")
			}
			reversed[variant] = append(reversed[variant], canonical)
		}
	}
	return reversed, nil
}

func (c *Catalog) rewriteQuery(query string) string {
	var extra []string
	for variant, canonicals := range c.synonyms {
		if !strings.Contains(query, variant) {
			continue
		}
		for _, term := range canonicals {
			if !strings.Contains(query, term) && !contains(extra, term) {
				extra = append(extra, term)
			}
		}
	}
	if len(extra) == 0 {
		return query
	}
	return query + " " + strings.Join(extra, " ")
}

var tokenRE = regexp.MustCompile(`[\p{L}\p{N}_]+`)

func MatchExpression(query string) string {
	tokens := tokenRE.FindAllString(strings.ToLower(query), 8)
	parts := make([]string, 0, len(tokens))
	for _, token := range tokens {
		seg := strings.TrimSpace(SegmentForIndex(token))
		seg = strings.ReplaceAll(seg, `"`, `""`)
		parts = append(parts, `"`+seg+`"`)
	}
	return strings.Join(parts, " OR ")
}

func normalize(values []string) map[string]bool {
	out := map[string]bool{}
	for _, v := range values {
		v = strings.TrimSpace(v)
		if v != "" {
			out[strings.ToLower(v)] = true
		}
	}
	return out
}

func contains(xs []string, v string) bool {
	for _, x := range xs {
		if x == v {
			return true
		}
	}
	return false
}

func round(v float64, places int) float64 {
	p := math.Pow(10, float64(places))
	return math.Round(v*p) / p
}
