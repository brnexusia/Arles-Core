import { env } from '../config/env.js';

export type AsaasCustomer = {
  id: string;
  name?: string;
  email?: string;
  mobilePhone?: string;
  cpfCnpj?: string;
  externalReference?: string;
};

export type AsaasAutomaticPixAuthorization = {
  id: string;
  status?: 'CREATED'|'ACTIVE'|'CANCELLED'|'EXPIRED'|'REFUSED'|string;
  customerId?: string;
  frequency?: string;
  value?: number;
  startDate?: string;
  subscription?: { id?: string } | string;
  immediateQrCode?: Record<string, unknown>;
  [key: string]: unknown;
};

class AsaasClient {
  private configured() {
    if (!env.asaasApiKey) throw new Error('ASAAS_NOT_CONFIGURED');
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    this.configured();
    const response = await fetch(`${env.asaasApiBaseUrl}${path}`, {
      ...init,
      headers: {
        accept: 'application/json',
        access_token: env.asaasApiKey,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(init.headers || {})
      }
    });
    const text = await response.text();
    let data: any = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!response.ok) {
      const detail = Array.isArray(data?.errors)
        ? data.errors.map((item: any) => item?.description || item?.code).filter(Boolean).join('; ')
        : data?.message || data?.error || text;
      throw new Error(`ASAAS_${response.status}${detail ? `:${String(detail).slice(0, 500)}` : ''}`);
    }
    return data as T;
  }

  async findCustomer(externalReference: string): Promise<AsaasCustomer | null> {
    const query = new URLSearchParams({ externalReference, limit: '1' });
    const result = await this.request<{ data?: AsaasCustomer[] }>(`/customers?${query.toString()}`);
    return result.data?.[0] ?? null;
  }

  async createCustomer(input: {
    name: string;
    cpfCnpj: string;
    mobilePhone: string;
    email?: string;
    externalReference: string;
  }): Promise<AsaasCustomer> {
    return this.request<AsaasCustomer>('/customers', {
      method: 'POST',
      body: JSON.stringify(input)
    });
  }

  async createAutomaticPixAuthorization(input: {
    customerId: string;
    contractId: string;
    startDate: string;
    value: number;
  }): Promise<AsaasAutomaticPixAuthorization> {
    return this.request<AsaasAutomaticPixAuthorization>('/pix/automatic/authorizations', {
      method: 'POST',
      body: JSON.stringify({
        frequency: 'MONTHLY',
        contractId: input.contractId.slice(0, 35),
        startDate: input.startDate,
        value: input.value,
        description: 'Arles Beauty mensalidade',
        customerId: input.customerId,
        immediateQrCode: {},
        paymentCreationMode: 'SUBSCRIPTION',
        retryPolicy: 'ALLOW_THREE_IN_SEVEN_DAYS'
      })
    });
  }

  async getAutomaticPixAuthorization(id: string): Promise<AsaasAutomaticPixAuthorization> {
    return this.request<AsaasAutomaticPixAuthorization>(`/pix/automatic/authorizations/${encodeURIComponent(id)}`);
  }

  async cancelAutomaticPixAuthorization(id: string): Promise<AsaasAutomaticPixAuthorization> {
    return this.request<AsaasAutomaticPixAuthorization>(`/pix/automatic/authorizations/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    });
  }
}

export const asaas = new AsaasClient();
