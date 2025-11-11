export interface PrintifyLineItemInput {
  productId: number;
  variantId: number;
  quantity: number;
  metadata?: Record<string, unknown> | null;
}

export interface PrintifyAddressInput {
  first_name: string;
  last_name: string;
  email: string;
  phone?: string;
  country: string;
  region?: string;
  address1: string;
  address2?: string;
  city: string;
  zip: string;
}

export interface CreatePrintifyOrderInput {
  external_id: string;
  label?: string;
  line_items: PrintifyLineItemInput[];
  shipping_method?: number;
  send_shipping_notification?: boolean;
  address_to: PrintifyAddressInput;
  metadata?: Record<string, unknown>;
}

export interface PrintifyOrderResponse {
  id: string;
  status: string;
  external_id?: string;
  shipments?: unknown[];
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface PrintifyClientOptions {
  apiToken: string;
  shopId: string;
  baseUrl?: string;
  mock?: boolean;
}

export class PrintifyClient {
  private readonly baseUrl: string;

  constructor(private readonly options: PrintifyClientOptions) {
    const base = options.baseUrl?.replace(/\/$/, '') || 'https://api.printify.com/v1';
    this.baseUrl = base;
  }

  async createOrder(input: CreatePrintifyOrderInput): Promise<PrintifyOrderResponse> {
    if (this.options.mock) {
      return {
        id: `mock-${Date.now()}`,
        status: 'mocked',
        external_id: input.external_id,
        metadata: {
          ...(input.metadata ?? {}),
          mock: true,
        },
      };
    }

    const url = `${this.baseUrl}/shops/${this.options.shopId}/orders.json`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.options.apiToken}`,
      },
      body: JSON.stringify(input),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Printify request failed with status ${response.status}: ${body}`);
    }

    return (await response.json()) as PrintifyOrderResponse;
  }
}
