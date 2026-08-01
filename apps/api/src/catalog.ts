import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR } from "./config.js";
import { Database, segmentForIndex } from "./database.js";
import type {
  KnowledgeHit,
  MarketingStrategy,
  Product,
  RecommendationDraftItem,
  RecommendationRequest,
  RecommendedProduct,
  UserContext,
  UserProfile,
  UserSegment,
} from "./types.js";

export class CatalogError extends Error {}

type SqlRow = Record<string, unknown>;

const productFromRow = (row: SqlRow): Product => ({
  product_id: String(row.product_id),
  name: String(row.name),
  category: String(row.category),
  price_cents: Number(row.price_cents),
  description: String(row.description),
  brand: String(row.brand),
  seller_id: String(row.seller_id),
  stock: Number(row.stock),
  tags: JSON.parse(String(row.tags_json)) as string[],
  popularity_score: Number(row.popularity_score),
  image_url: String(row.image_url),
  source: String(row.source),
});

const profileFromRow = (row: SqlRow): UserProfile => ({
  user_id: String(row.user_id),
  segment: String(row.segment) as UserSegment,
  preferred_categories: JSON.parse(
    String(row.preferred_categories_json),
  ) as string[],
  min_price_cents: Number(row.min_price_cents),
  max_price_cents: Number(row.max_price_cents),
  recent_views: JSON.parse(String(row.recent_views_json)) as string[],
  recent_purchases: JSON.parse(String(row.recent_purchases_json)) as string[],
});

const normalize = (values: string[]): Set<string> =>
  new Set(
    values
      .filter((value) => value.trim())
      .map((value) => value.toLocaleLowerCase()),
  );

export class Catalog {
  readonly products: Product[];
  readonly profiles: Map<string, UserProfile>;
  readonly forbiddenWords: string[];
  readonly categories: string[];
  readonly #database: Database;
  readonly #templates: Map<string, MarketingStrategy>;
  readonly #synonyms: Map<string, string[]>;

  constructor(options: { databasePath?: string; dataDir?: string } = {}) {
    const dataDir = options.dataDir ?? DATA_DIR;
    this.#database = new Database(options.databasePath, dataDir);
    this.products = this.#listProducts();
    this.profiles = new Map(
      (
        this.#database.connection
          .prepare("SELECT * FROM user_profiles ORDER BY user_id")
          .all() as SqlRow[]
      ).map((row) => {
        const profile = profileFromRow(row);
        return [profile.user_id, profile];
      }),
    );
    this.forbiddenWords = (
      this.#database.connection
        .prepare("SELECT word FROM forbidden_words ORDER BY rowid")
        .all() as SqlRow[]
    ).map((row) => String(row.word));
    this.#templates = new Map(
      (
        this.#database.connection
          .prepare("SELECT * FROM marketing_templates")
          .all() as SqlRow[]
      ).map((row) => [
        String(row.segment),
        {
          segment: String(row.segment) as UserSegment,
          tone: String(row.tone),
          instructions: String(row.instructions),
          forbidden_words: this.forbiddenWords,
        },
      ]),
    );
    this.categories = [
      ...new Set(this.products.map((product) => product.category)),
    ].sort();
    this.#synonyms = this.#loadSynonyms(join(dataDir, "query_synonyms.json"));
  }

  close(): void {
    this.#database.close();
  }

  userProfile(userId: string, overrides: UserContext = {}): UserProfile {
    const base =
      this.profiles.get(userId) ??
      ({
        user_id: userId,
        segment: "new_user",
        preferred_categories: [],
        min_price_cents: 0,
        max_price_cents: 1_000_000,
        recent_views: [],
        recent_purchases: [],
      } satisfies UserProfile);
    return {
      ...base,
      preferred_categories: overrides.preferred_categories?.length
        ? overrides.preferred_categories
        : base.preferred_categories,
      // 单边价格约束代表本轮的新区间，另一端应开放，不能继承与它冲突的历史画像。
      min_price_cents:
        overrides.min_price_cents ??
        (overrides.max_price_cents === undefined ? base.min_price_cents : 0),
      max_price_cents:
        overrides.max_price_cents ??
        (overrides.min_price_cents === undefined
          ? base.max_price_cents
          : 1_000_000),
      recent_views: overrides.recent_views?.length
        ? overrides.recent_views
        : base.recent_views,
      recent_purchases: overrides.recent_purchases?.length
        ? overrides.recent_purchases
        : base.recent_purchases,
    };
  }

  search(input: {
    profile: UserProfile;
    categories: string[];
    min_price_cents: number;
    max_price_cents: number;
    tags: string[];
    limit: number;
  }): Product[] {
    if (
      input.min_price_cents < 0 ||
      input.max_price_cents <= 0 ||
      input.min_price_cents > input.max_price_cents
    ) {
      throw new CatalogError("invalid_product_search_price_range");
    }
    if (input.limit < 1 || input.limit > 20)
      throw new CatalogError("invalid_product_search_limit");
    const categories = normalize(input.categories);
    const tags = normalize(input.tags);
    if (input.categories.length && !categories.size)
      throw new CatalogError("invalid_product_search_categories");
    if (input.tags.length && !tags.size)
      throw new CatalogError("invalid_product_search_tags");

    return this.products
      .filter(
        (product) =>
          product.price_cents >= input.min_price_cents &&
          product.price_cents <= input.max_price_cents &&
          (!categories.size ||
            categories.has(product.category.toLocaleLowerCase())) &&
          (!tags.size ||
            product.tags.some((tag) => tags.has(tag.toLocaleLowerCase()))),
      )
      .sort(
        (left, right) =>
          this.#score(right, input.profile) - this.#score(left, input.profile),
      )
      .slice(0, input.limit);
  }

  inventory(productIds: string[]): Product[] {
    const products = new Map(
      this.#listProducts().map((product) => [product.product_id, product]),
    );
    return [...new Set(productIds)].flatMap((id) => {
      const product = products.get(id);
      return product && product.stock > 0 ? [product] : [];
    });
  }

  retrieveKnowledge(input: {
    query: string;
    categories: string[];
    product_ids: string[];
    limit: number;
  }): KnowledgeHit[] {
    if (input.limit < 1 || input.limit > 8)
      throw new CatalogError("invalid_knowledge_limit");
    // 类目是 Harness 已知的稳定检索词，优先于模型生成的长 query 进入 FTS token 上限。
    const expression = this.#matchExpression(
      this.#rewriteQuery([...input.categories, input.query].join(" ")),
    );
    if (!expression) return [];

    const filters: string[] = [];
    const parameters: Array<string | number> = [expression];
    if (input.categories.length) {
      filters.push(
        `f.category IN (${input.categories.map(() => "?").join(",")})`,
      );
      parameters.push(...input.categories);
    }
    if (input.product_ids.length) {
      filters.push(
        `(f.product_id IN (${input.product_ids.map(() => "?").join(",")}) OR f.product_id IS NULL)`,
      );
      parameters.push(...input.product_ids);
    }
    parameters.push(input.limit);
    const rows = this.#database.connection
      .prepare(
        `
      SELECT d.doc_id, d.title, f.chunk_ordinal, f.raw_content AS content,
             d.category, d.product_id, d.source, bm25(knowledge_documents_fts) AS rank
      FROM knowledge_documents_fts AS f JOIN knowledge_documents AS d ON d.doc_id = f.doc_id
      WHERE knowledge_documents_fts MATCH ? ${filters.length ? `AND ${filters.join(" AND ")}` : ""}
      ORDER BY rank, f.rowid LIMIT ?
    `,
      )
      .all(...parameters) as SqlRow[];
    return rows.map((row) => ({
      doc_id: String(row.doc_id),
      title: String(row.title),
      content: String(row.content),
      category: String(row.category),
      product_id: row.product_id === null ? null : String(row.product_id),
      source: String(row.source),
      chunk_ordinal: Number(row.chunk_ordinal),
      relevance_score:
        Math.round((1 / (1 + Math.abs(Number(row.rank)))) * 10_000) / 10_000,
    }));
  }

  marketingStrategy(segment: string): MarketingStrategy {
    const strategy = this.#templates.get(segment);
    if (!strategy) throw new CatalogError("unknown_marketing_segment");
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
    const seen = new Set<string>();
    const recommendations: RecommendedProduct[] = [];
    for (const item of draft) {
      if (seen.has(item.product_id)) continue;
      const product = current.get(item.product_id);
      if (!product) throw new CatalogError("unknown_recommended_product");
      seen.add(item.product_id);
      if (
        product.stock <= 0 ||
        product.price_cents < profile.min_price_cents ||
        product.price_cents > profile.max_price_cents
      )
        continue;
      recommendations.push({
        product_id: product.product_id,
        name: product.name,
        category: product.category,
        price_cents: product.price_cents,
        brand: product.brand,
        stock: product.stock,
        tags: product.tags,
        score: this.#score(product, profile),
        low_stock: product.stock <= 100,
        reason: this.#sanitize(item.reason),
        marketing_copy: this.#sanitize(item.marketing_copy),
      });
      if (recommendations.length >= (request.num_items ?? 5)) break;
    }
    if (!recommendations.length)
      throw new CatalogError("no_available_recommendations");
    this.rememberPreference(
      request.user_id,
      request.context?.preferred_categories ?? [],
    );
    return recommendations;
  }

  rememberPreference(userId: string, categories: string[]): void {
    const profile = this.profiles.get(userId);
    const preferred = [
      ...new Set(categories.filter((category) => category.trim())),
    ];
    if (!profile || !preferred.length) return;
    this.#database.connection
      .prepare(
        "UPDATE user_profiles SET preferred_categories_json = ? WHERE user_id = ?",
      )
      .run(JSON.stringify(preferred), userId);
    this.profiles.set(userId, { ...profile, preferred_categories: preferred });
  }

  #listProducts(): Product[] {
    return (
      this.#database.connection
        .prepare("SELECT * FROM products ORDER BY product_id")
        .all() as SqlRow[]
    ).map(productFromRow);
  }

  #score(product: Product, profile: UserProfile): number {
    const preferred = normalize(profile.preferred_categories);
    const signals = normalize([
      ...profile.recent_views,
      ...profile.recent_purchases,
    ]);
    const searchable = normalize([
      product.name,
      product.category,
      ...product.tags,
    ]);
    let score = product.popularity_score * 0.55;
    if (preferred.has(product.category.toLocaleLowerCase())) score += 0.25;
    if ([...signals].some((signal) => searchable.has(signal))) score += 0.15;
    if (
      product.price_cents >= profile.min_price_cents &&
      product.price_cents <= profile.max_price_cents
    )
      score += 0.05;
    return Math.round(Math.min(score, 1) * 10_000) / 10_000;
  }

  #sanitize(text: string): string {
    return this.forbiddenWords.reduce(
      (result, word) => result.replaceAll(word, "***"),
      text,
    );
  }

  #loadSynonyms(path: string): Map<string, string[]> {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >;
    const reversed = new Map<string, string[]>();
    for (const [canonical, variants] of Object.entries(raw)) {
      if (canonical.startsWith("_") || !Array.isArray(variants)) continue;
      for (const variant of variants) {
        if (typeof variant !== "string") continue;
        reversed.set(variant, [...(reversed.get(variant) ?? []), canonical]);
      }
    }
    return reversed;
  }

  #rewriteQuery(query: string): string {
    const extra = [...this.#synonyms.entries()]
      .filter(([variant]) => query.includes(variant))
      .flatMap(([, canonical]) => canonical)
      .filter(
        (term, index, terms) =>
          !query.includes(term) && terms.indexOf(term) === index,
      );
    return extra.length ? `${query} ${extra.join(" ")}` : query;
  }

  #matchExpression(query: string): string {
    return (query.toLocaleLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])
      .slice(0, 8)
      .map(
        (token) => `"${segmentForIndex(token).trim().replaceAll('"', '""')}"`,
      )
      .join(" OR ");
  }
}
