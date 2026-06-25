import type {
  ConfigInfo,
  CustomerListResponse,
  KnowledgeAddPayload,
  KnowledgeContentType,
  KnowledgeListResponse,
  KnowledgeSourceType,
  ReviewSummary,
} from './types';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`${url} -> ${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

export function fetchConfig() {
  return request<ConfigInfo>('/config/info');
}

export function fetchSummary() {
  return request<ReviewSummary>('/reviews/summary');
}

export function fetchCustomers(page = 1, limit = 50) {
  return request<CustomerListResponse>(`/memories/all?page=${page}&limit=${limit}`);
}

export function triggerReEvaluate(customerId: string, productId?: string, conversationId?: string) {
  return request('/reviews/evaluate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customerId, productId, conversationId }),
  });
}

export interface KnowledgeListParams {
  page?: number;
  limit?: number;
  search?: string;
  sourceType?: KnowledgeSourceType | 'all';
  contentType?: KnowledgeContentType | 'all';
  title?: string;
}

export function fetchKnowledge(params: KnowledgeListParams = {}) {
  const qs = new URLSearchParams();
  if (params.page) qs.set('page', String(params.page));
  if (params.limit) qs.set('limit', String(params.limit));
  if (params.search) qs.set('search', params.search);
  if (params.sourceType && params.sourceType !== 'all') qs.set('sourceType', params.sourceType);
  if (params.contentType && params.contentType !== 'all') qs.set('contentType', params.contentType);
  if (params.title) qs.set('title', params.title);
  const suffix = qs.toString();
  return request<KnowledgeListResponse>(`/knowledge/list${suffix ? `?${suffix}` : ''}`);
}

export function addKnowledge(payload: KnowledgeAddPayload) {
  return request<{ ok: boolean; added: number; replacedOldCount: number; title: string }>(
    '/knowledge/add',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
  );
}

export function deleteKnowledge(body: { pointIds: string[] } | { title: string }) {
  return request<{ ok: boolean; deleted: number }>('/knowledge/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export interface KnowledgeTemplate {
  key: string;
  label: string;
  matchesFormat: 'qa' | 'csv' | 'json' | 'markdown' | 'text';
  description: string;
  downloadUrl: string;
  downloadAs: string;
}

export function fetchTemplates() {
  return request<{ templates: KnowledgeTemplate[] }>('/knowledge/templates');
}

export function captionImage(body: {
  imageUrl?: string;
  imageBase64?: string;
  mimeType?: string;
  productId?: string;
  productName?: string;
  hint?: string;
}) {
  return request<{ ok: boolean; caption: string; model: string }>('/knowledge/media/caption', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function uploadMedia(file: File) {
  return new Promise<{ url: string; fileName: string; size: number; mimeType: string }>(
    (resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('读取图片失败'));
      reader.onload = async () => {
        try {
          const dataUrl = String(reader.result ?? '');
          const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
          const resp = await fetch('/knowledge/media/upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              filename: file.name,
              mimeType: file.type || 'image/png',
              base64,
            }),
          });
          if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            reject(new Error(err.error?.message ?? JSON.stringify(err) ?? `HTTP ${resp.status}`));
            return;
          }
          resolve(await resp.json());
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      };
      reader.readAsDataURL(file);
    },
  );
}
