import { AvailabilityQueryInput, AvailabilityQueryResult } from './types.js';

export async function queryAvailability(_input: AvailabilityQueryInput): Promise<AvailabilityQueryResult> {
  return {
    available: true,
    availableSize: 'L',
    checkedAt: new Date().toISOString(),
    source: 'api',
  };
}