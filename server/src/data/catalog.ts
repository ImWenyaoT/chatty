/** 商品、画像、库存、知识与营销数据的统一访问入口。 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Database, SeedDataError, segmentForIndex } from "./database.ts";
import { DATA_DIR } from "../paths.ts";
import {
  emptyUserContext,
  type KnowledgeHit,
  type MarketingStrategy,
  type Product,
  type RecommendationDraftItem,
  type RecommendationRequest,
  type RecommendedProduct,
  type UserContext,
  type UserProfile,
  type UserSegment,
} from "./models.ts";
import { round } from "./round.ts";

export const MAX_PRICE_CENTS = 1_000_000;

/** Catalog 输入或业务结果无效。 */
export class CatalogError extends Error {}

type ProductRow = {
  product_id: string;
  name: string;
  category: string;
  price_cents: number;
  description: string;
  brand: string;
  seller_id: string;
  stock: number;
  tags_json: string;
  popularity_score: number;
  image_url: string;
  source: string;
};

type ProfileRow = {
  user_id: string;
  segment: UserSegment;
  preferred_categories_json: string;
  min_price_cents: number;
  max_price_cents: number;
  recent_views_json: string;
  recent_purchases_json: string;
};

function productFromRow(row: ProductRow): Product {
  return {
    product_id: row.product_id,
    name: row.name,
    category: row.category,
    price_cents: row.price_cents,
    description: row.description,
    brand: row.brand,
    seller_id: row.seller_id,
    stock: row.stock,
    tags: JSON.parse(row.tags_json) as string[],
    popularity_score: row.popularity_score,
    image_url: row.image_url,
    source: row.source,
  };
}

function profileFromRow(row: ProfileRow): UserProfile {
  return {
    user_id: row.user_id,
    segment: row.segment,
    preferred_categories: JSON.parse(row.preferred_categories_json) as string[],
    min_price_cents: row.min_price_cents,
    max_price_cents: row.max_price_cents,
    recent_views: JSON.parse(row.recent_views_json) as string[],
    recent_purchases: JSON.parse(row.recent_purchases_json) as string[],
  };
}

function normalize(values: string[]): Set<string> {
  return new Set(
    values.filter((value) => value.trim()).map((value) => value.trim().toLowerCase()),
  );
}

export class Catalog {
  readonly products: Product[];
  readonly profiles: Map<string, UserProfile>;
  readonly forbiddenWords: string[];
  readonly categories: string[];

  readonly #database: Database;
  readonly #templates: Map<string, MarketingStrategy>;
  readonly #synonyms: Map<string, string[]>;

  constructor(databasePath: string = ":memory:", dataDir: URL = DATA_DIR) {
    this.#database = new Database(databasePath, dataDir);
    this.products = this.#listProducts();
    this.profiles = this.#loadProfiles();
    this.forbiddenWords = this.#loadForbiddenWords();
    this.#templates = this.#loadMarketingTemplates();
    this.categories = [
      ...new Set(this.products.map((product) => product.category)),
    ].sort();
    this.#synonyms = Catalog.#loadSynonyms(new URL("query_synonyms.json", dataDir));
  }

  close(): void {
    this.#database.close();
  }

  userProfile(userId: string, overrides: UserContext = emptyUserContext()): UserProfile {
    const base = this.profiles.get(userId);
    if (base === undefined) throw new CatalogError("unknown_user");

    let preferredCategories = base.preferred_categories;
    if (overrides.preferred_categories?.length) {
      preferredCategories = overrides.preferred_categories;
    }

    // 单边价格约束代表本轮新区间，另一端应开放，不能继承冲突的历史区间。
    let minPriceCents = overrides.min_price_cents;
    if (minPriceCents === null) {
      minPriceCents = overrides.max_price_cents === null ? base.min_price_cents : 0;
    }

    let maxPriceCents = overrides.max_price_cents;
    if (maxPriceCents === null) {
      maxPriceCents =
        overrides.min_price_cents === null ? base.max_price_cents : MAX_PRICE_CENTS;
    }

    return {
      user_id: base.user_id,
      segment: base.segment,
      preferred_categories: preferredCategories,
      min_price_cents: minPriceCents,
      max_price_cents: maxPriceCents,
      recent_views: overrides.recent_views?.length
        ? overrides.recent_views
        : base.recent_views,
      recent_purchases: overrides.recent_purchases?.length
        ? overrides.recent_purchases
        : base.recent_purchases,
    };
  }

  search(options: {
    profile: UserProfile;
    categories: string[];
    minPriceCents: number;
    maxPriceCents: number;
    limit: number;
  }): Product[] {
    const { profile, categories, minPriceCents, maxPriceCents, limit } = options;
    if (minPriceCents < 0 || maxPriceCents <= 0 || minPriceCents > maxPriceCents) {
      throw new CatalogError("invalid_product_search_price_range");
    }
    if (limit < 1 || limit > 20) {
      throw new CatalogError("invalid_product_search_limit");
    }

    const normalizedCategories = normalize(categories);
    if (categories.length > 0 && normalizedCategories.size === 0) {
      throw new CatalogError("invalid_product_search_categories");
    }

    const matches = this.products.filter((product) => {
      if (product.price_cents < minPriceCents || product.price_cents > maxPriceCents) {
        return false;
      }
      return (
        normalizedCategories.size === 0 ||
        normalizedCategories.has(product.category.toLowerCase())
      );
    });

    // Python 的 sort(reverse=True) 与 JS 的比较器排序都是稳定的，分数相同则保持原顺序。
    matches.sort(
      (left, right) => this.#score(right, profile) - this.#score(left, profile),
    );
    return matches.slice(0, limit);
  }

  inventory(productIds: string[]): Product[] {
    const current = new Map(
      this.#listProducts().map((product) => [product.product_id, product]),
    );
    const unknown = [...new Set(productIds)].filter((id) => !current.has(id)).sort();
    if (unknown.length > 0) {
      throw new CatalogError(`unknown_inventory_product:${unknown.join(",")}`);
    }

    const available: Product[] = [];
    const seen = new Set<string>();
    for (const productId of productIds) {
      if (seen.has(productId)) continue;
      seen.add(productId);
      const product = current.get(productId);
      if (product !== undefined && product.stock > 0) available.push(product);
    }
    return available;
  }

  retrieveKnowledge(options: {
    query: string;
    categories: string[];
    productIds: string[];
    limit: number;
  }): KnowledgeHit[] {
    const { query, categories, productIds, limit } = options;
    if (limit < 1 || limit > 8) throw new CatalogError("invalid_knowledge_limit");

    // Harness 已知的类目放在 query 前，避免长商品名挤掉稳定检索词。
    const combinedQuery = [...categories, query].join(" ");
    const expression = Catalog.#matchExpression(this.#rewriteQuery(combinedQuery));
    if (!expression) throw new CatalogError("empty_knowledge_query");

    const filters: string[] = [];
    const parameters: (string | number)[] = [expression];
    if (categories.length > 0) {
      filters.push(`f.category IN (${categories.map(() => "?").join(",")})`);
      parameters.push(...categories);
    }
    if (productIds.length > 0) {
      filters.push(
        `(f.product_id IN (${productIds.map(() => "?").join(",")}) OR f.product_id IS NULL)`,
      );
      parameters.push(...productIds);
    }

    const filterSql = filters.length > 0 ? ` AND ${filters.join(" AND ")}` : "";
    parameters.push(limit);

    const rows = this.#database.connection
      .prepare(
        `
        SELECT d.doc_id, d.title, f.chunk_ordinal,
               f.raw_content AS content, d.category, d.product_id,
               d.source, bm25(knowledge_documents_fts) AS rank
        FROM knowledge_documents_fts AS f
        JOIN knowledge_documents AS d ON d.doc_id = f.doc_id
        WHERE knowledge_documents_fts MATCH ?${filterSql}
        ORDER BY rank, f.rowid
        LIMIT ?
        `,
      )
      .all(...parameters) as {
      doc_id: string;
      title: string;
      chunk_ordinal: number;
      content: string;
      category: string;
      product_id: string | null;
      source: string;
      rank: number;
    }[];

    return rows.map((row) => ({
      doc_id: row.doc_id,
      title: row.title,
      content: row.content,
      category: row.category,
      product_id: row.product_id,
      source: row.source,
      chunk_ordinal: row.chunk_ordinal,
      relevance_score: round(1 / (1 + Math.abs(row.rank)), 4),
    }));
  }

  marketingStrategy(segment: string): MarketingStrategy {
    const strategy = this.#templates.get(segment);
    if (strategy === undefined) throw new CatalogError("unknown_marketing_segment");
    return strategy;
  }

  finalize(
    draft: RecommendationDraftItem[],
    request: RecommendationRequest,
    profile: UserProfile,
  ): RecommendedProduct[] {
    const current = new Map(
      this.#listProducts().map((product) => [product.product_id, product]),
    );
    const recommendations: RecommendedProduct[] = [];
    const seen = new Set<string>();

    for (const item of draft) {
      if (seen.has(item.product_id)) {
        throw new CatalogError("duplicate_recommended_product");
      }
      const product = current.get(item.product_id);
      if (product === undefined) throw new CatalogError("unknown_recommended_product");
      seen.add(item.product_id);

      if (product.stock <= 0) throw new CatalogError("recommended_product_out_of_stock");
      const insidePriceRange =
        product.price_cents >= profile.min_price_cents &&
        product.price_cents <= profile.max_price_cents;
      if (!insidePriceRange) {
        throw new CatalogError("recommended_product_outside_price_range");
      }

      recommendations.push({
        product_id: product.product_id,
        name: product.name,
        category: product.category,
        price_cents: product.price_cents,
        brand: product.brand,
        stock: product.stock,
        tags: product.tags,
        low_stock: product.stock <= 100,
        reason: this.#sanitize(item.reason),
        marketing_copy: this.#sanitize(item.marketing_copy),
      });
      if (recommendations.length >= request.num_items) break;
    }

    if (recommendations.length === 0) {
      throw new CatalogError("no_available_recommendations");
    }
    return recommendations;
  }

  /** 只把一次成功请求里明确表达的类目写入画像。 */
  updateUserProfileAfterSuccess(userId: string, categories: string[]): void {
    const profile = this.profiles.get(userId);
    const preferred: string[] = [];
    const seen = new Set<string>();
    for (const category of categories) {
      if (!category.trim() || seen.has(category)) continue;
      preferred.push(category);
      seen.add(category);
    }
    if (profile === undefined || preferred.length === 0) return;

    this.#database.connection
      .prepare(
        `UPDATE user_profiles
           SET preferred_categories_json = ?
           WHERE user_id = ?`,
      )
      .run(JSON.stringify(preferred), userId);
    this.profiles.set(userId, { ...profile, preferred_categories: preferred });
  }

  #listProducts(): Product[] {
    const rows = this.#database.connection
      .prepare("SELECT * FROM products ORDER BY product_id")
      .all() as ProductRow[];
    return rows.map(productFromRow);
  }

  #loadProfiles(): Map<string, UserProfile> {
    const rows = this.#database.connection
      .prepare("SELECT * FROM user_profiles ORDER BY user_id")
      .all() as ProfileRow[];
    return new Map(rows.map((row) => [row.user_id, profileFromRow(row)]));
  }

  #loadForbiddenWords(): string[] {
    const rows = this.#database.connection
      .prepare("SELECT word FROM forbidden_words ORDER BY rowid")
      .all() as { word: string }[];
    return rows.map((row) => row.word);
  }

  #loadMarketingTemplates(): Map<string, MarketingStrategy> {
    const rows = this.#database.connection
      .prepare("SELECT * FROM marketing_templates")
      .all() as { segment: UserSegment; tone: string; instructions: string }[];
    return new Map(
      rows.map((row) => [
        row.segment,
        {
          segment: row.segment,
          tone: row.tone,
          instructions: row.instructions,
          forbidden_words: this.forbiddenWords,
        },
      ]),
    );
  }

  #score(product: Product, profile: UserProfile): number {
    const preferred = normalize(profile.preferred_categories);
    const signals = normalize([...profile.recent_views, ...profile.recent_purchases]);
    const searchable = normalize([product.name, product.category, ...product.tags]);

    let score = product.popularity_score * 0.55;
    if (preferred.has(product.category.toLowerCase())) score += 0.25;
    if ([...signals].some((signal) => searchable.has(signal))) score += 0.15;
    if (
      product.price_cents >= profile.min_price_cents &&
      product.price_cents <= profile.max_price_cents
    ) {
      score += 0.05;
    }
    return round(Math.min(score, 1), 4);
  }

  #sanitize(text: string): string {
    let sanitized = text;
    for (const word of this.forbiddenWords) sanitized = sanitized.replaceAll(word, "***");
    return sanitized;
  }

  static #loadSynonyms(path: URL): Map<string, string[]> {
    const raw: unknown = JSON.parse(readFileSync(fileURLToPath(path), "utf8"));
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new SeedDataError("invalid_query_synonyms");
    }
    const reversed = new Map<string, string[]>();
    for (const [canonical, variants] of Object.entries(raw)) {
      if (canonical.startsWith("_")) continue;
      if (!Array.isArray(variants))
        throw new SeedDataError("invalid_query_synonym_variants");
      for (const variant of variants) {
        if (typeof variant !== "string") {
          throw new SeedDataError("invalid_query_synonym_variant");
        }
        const existing = reversed.get(variant);
        if (existing === undefined) reversed.set(variant, [canonical]);
        else existing.push(canonical);
      }
    }
    return reversed;
  }

  #rewriteQuery(query: string): string {
    const extraTerms: string[] = [];
    for (const [variant, canonicalTerms] of this.#synonyms) {
      if (!query.includes(variant)) continue;
      for (const term of canonicalTerms) {
        if (!query.includes(term) && !extraTerms.includes(term)) extraTerms.push(term);
      }
    }
    if (extraTerms.length === 0) return query;
    return `${query} ${extraTerms.join(" ")}`;
  }

  static #matchExpression(query: string): string {
    // Python 的 `\w` 在 re.UNICODE 下匹配中文，JS 的 `\w` 只有 ASCII，必须用属性转义。
    const tokens = (query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).slice(0, 8);
    return tokens
      .map((token) => `"${segmentForIndex(token).trim().replaceAll('"', '""')}"`)
      .join(" OR ");
  }

  /** 只在 golden 对拍中使用，用于冻结查询改写与 FTS 表达式的跨语言行为。 */
  rewriteQueryForGolden(query: string): string {
    return this.#rewriteQuery(query);
  }

  static matchExpressionForGolden(query: string): string {
    return Catalog.#matchExpression(query);
  }

  scoreForGolden(product: Product, profile: UserProfile): number {
    return this.#score(product, profile);
  }
}
