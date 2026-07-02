import type { ConfigInfo, CustomerListResponse, ReviewSummary } from './types';

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
