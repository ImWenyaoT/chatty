import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { config } from './config.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const configDir = path.resolve(currentDir, '..', 'config');

export interface PromptsFile {
  stylistPrompt: string;
  systemSupplement: string;
  evaluatorSystemPrompt: string;
  evaluatorUserTemplate: string;
  factExtractorSystemPrompt: string;
}

export interface SizeRule {
  minHeight: number;
  maxHeight: number;
  minWeight: number;
  maxWeight: number;
  size: string;
  confidence: 'low' | 'medium' | 'high';
}

export interface ProductEntry {
  id: string;
  name: string;
  dailyPrice?: number;
  renewalDailyPrice?: number;
  currency?: string;
  shippingPolicy?: string;
  pricingNote?: string;
}

export interface CatalogFile {
  products: ProductEntry[];
  sizeRules: SizeRule[];
  sizeFallback: {
    size: string;
    confidence: 'low' | 'medium' | 'high';
  };
}

function readYaml<T>(filePath: string): { data: T; raw: string } {
  const raw = fs.readFileSync(filePath, 'utf8');
  return { data: YAML.parse(raw) as T, raw };
}

function shortHash(input: string) {
  return createHash('sha1').update(input).digest('hex').slice(0, 6);
}

function loadAll() {
  const versionName = config.promptVersionName;
  const promptsPath = path.join(configDir, 'prompts', `${versionName}.yaml`);
  const catalogPath = path.join(configDir, 'catalog.yaml');

  const prompts = readYaml<PromptsFile>(promptsPath);
  const catalog = readYaml<CatalogFile>(catalogPath);

  const requiredPromptKeys: (keyof PromptsFile)[] = [
    'stylistPrompt',
    'systemSupplement',
    'evaluatorSystemPrompt',
    'evaluatorUserTemplate',
    'factExtractorSystemPrompt',
  ];
  for (const key of requiredPromptKeys) {
    if (!prompts.data?.[key]) {
      throw new Error(`[prompts-loader] ${promptsPath} missing field: ${key}`);
    }
  }
  if (!Array.isArray(catalog.data?.products)) {
    throw new Error(`[prompts-loader] ${catalogPath} missing products array`);
  }
  if (!Array.isArray(catalog.data?.sizeRules)) {
    throw new Error(`[prompts-loader] ${catalogPath} missing sizeRules array`);
  }

  const combinedRaw = `${prompts.raw}\n---\n${catalog.raw}`;
  const promptVersion = `${versionName}-${shortHash(combinedRaw)}`;

  return {
    versionName,
    promptVersion,
    prompts: prompts.data,
    catalog: catalog.data,
  };
}

export const loaded = loadAll();

export function findProduct(productId: string | undefined): ProductEntry | undefined {
  if (!productId) return undefined;
  return loaded.catalog.products.find((item) => item.id === productId);
}

export function pickSizeByMeasurement(heightCm: number, weightKg: number) {
  const match = loaded.catalog.sizeRules.find(
    (rule) =>
      heightCm >= rule.minHeight &&
      heightCm <= rule.maxHeight &&
      weightKg >= rule.minWeight &&
      weightKg <= rule.maxWeight,
  );
  if (match) {
    return { size: match.size, confidence: match.confidence };
  }
  return loaded.catalog.sizeFallback;
}

export function renderTemplate(template: string, vars: Record<string, string>) {
  return template.replace(/{{\s*(\w+)\s*}}/g, (_, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : '',
  );
}
