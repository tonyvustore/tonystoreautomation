const LOGIN_MUTATION = /* GraphQL */ `
  mutation AdminLogin($username: String!, $password: String!) {
    login(username: $username, password: $password, rememberMe: true) {
      __typename
      ... on CurrentUser {
        id
        identifier
      }
      ... on InvalidCredentialsError {
        message
      }
    }
  }
`;

export type OrderState =
  | 'Created'
  | 'AddingItems'
  | 'ArrangingPayment'
  | 'PaymentAuthorized'
  | 'PaymentSettled'
  | 'PartiallyFulfilled'
  | 'Fulfilled'
  | 'PartiallyShipped'
  | 'Shipped'
  | 'PartiallyDelivered'
  | 'Delivered'
  | 'Cancelled';

const ORDERS_TO_FULFILL_QUERY = /* GraphQL */ `
  query OrdersToFulfill($take: Int!) {
    orders(options: { take: $take, sort: { createdAt: ASC } }) {
      items {
        id
        code
        state
        createdAt
        fulfillments {
          id
          state
          trackingCode
        }
        lines {
          id
          quantity
          productVariant {
            id
            sku
            name
          }
          fulfillmentLines {
            quantity
          }
        }
        shippingAddress {
          fullName
          company
          streetLine1
          streetLine2
          city
          province
          postalCode
          countryCode
          phoneNumber
        }
        customer {
          emailAddress
        }
      }
    }
  }
`;

const CREATE_FULFILLMENT_MUTATION = /* GraphQL */ `
  mutation CreateFulfillment($input: CreateFulfillmentInput!) {
    createFulfillment(input: $input) {
      __typename
      ... on Fulfillment {
        id
        state
        method
      }
      ... on CreateFulfillmentError {
        errorCode
        message
      }
      ... on InsufficientStockError {
        errorCode
        message
      }
      ... on OrderStateTransitionError {
        errorCode
        message
        transitionError
      }
    }
  }
`;

const ADD_FULFILLMENT_TO_ORDER_MUTATION = /* GraphQL */ `
  mutation AddFulfillmentToOrder($input: FulfillOrderInput!) {
    addFulfillmentToOrder(input: $input) {
      __typename
      ... on Fulfillment {
        id
        state
        method
      }
      ... on ErrorResult {
        errorCode
        message
      }
    }
  }
`;

const ORDER_BY_CODE_QUERY = /* GraphQL */ `
  query OrderByCode($code: String!) {
    orderByCode(code: $code) {
      id
      code
      state
      createdAt
      fulfillments {
        id
        state
        trackingCode
      }
      lines {
        id
        quantity
        productVariant {
          id
          sku
          name
        }
        fulfillmentLines {
          quantity
        }
      }
      shippingAddress {
        fullName
        company
        streetLine1
        streetLine2
        city
        province
        postalCode
        countryCode
        phoneNumber
      }
      customer {
        emailAddress
      }
    }
  }
`;

const PRODUCT_BY_ID_QUERY = /* GraphQL */ `
  query ProductById($id: ID!) {
    product(id: $id) {
      id
      slug
      name
      description
      assets { preview source type }
      variants { id sku name price priceWithTax currencyCode }
    }
  }
`;

const PRODUCT_BY_SLUG_QUERY = /* GraphQL */ `
  query ProductBySlug($slug: String!) {
    productBySlug(slug: $slug) {
      id
      slug
      name
      description
      assets { preview source type }
      variants { id sku name price priceWithTax currencyCode }
    }
  }
`;
export interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

interface RawOrderLine {
  id: string;
  quantity: number;
  productVariant: {
    id: string;
    sku: string | null;
    name: string;
  };
  fulfillmentLines?: {
    quantity: number;
  }[] | null;
}

interface RawOrder {
  id: string;
  code: string;
  state: OrderState;
  createdAt: string;
  fulfillments: { id: string; state: string; trackingCode?: string | null }[];
  lines: RawOrderLine[];
  shippingAddress?: {
    fullName?: string | null;
    company?: string | null;
    streetLine1?: string | null;
    streetLine2?: string | null;
    city?: string | null;
    province?: string | null;
    provinceCode?: string | null;
    postalCode?: string | null;
    countryCode?: string | null;
    phoneNumber?: string | null;
  } | null;
  customer?: {
    emailAddress?: string | null;
  } | null;
}

export interface OrderLineSummary {
  id: string;
  quantity: number;
  fulfilledQuantity: number;
  productVariant: {
    id: string;
    sku: string | null;
    name: string;
  };
}

export interface OrderSummary {
  id: string;
  code: string;
  state: OrderState;
  createdAt: string;
  fulfillments: { id: string; state: string; trackingCode?: string | null }[];
  lines: OrderLineSummary[];
  shippingAddress?: RawOrder['shippingAddress'];
  customer?: RawOrder['customer'];
}

export interface ProductVariantSummary {
  id: string;
  sku: string | null;
  name: string;
  price: number;
  priceWithTax: number;
  currencyCode: string;
}

export interface ProductSummary {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  assets: { preview?: string | null; source?: string | null; type?: string | null }[];
  variants: ProductVariantSummary[];
}

export type CreateFulfillmentResult =
  | {
      success: true;
      fulfillmentId: string;
      state: string;
      method: string | null;
    }
  | {
      success: false;
      message: string;
    };

type FulfillmentSuccess = { __typename: 'Fulfillment'; id: string; state: string; method: string | null };

type FulfillmentError =
  | { __typename: 'CreateFulfillmentError'; message?: string; transitionError?: string; errorCode?: string }
  | { __typename: 'InsufficientStockError'; message?: string; transitionError?: string; errorCode?: string }
  | { __typename: 'OrderStateTransitionError'; message?: string; transitionError?: string; errorCode?: string }
  | { __typename: string; message?: string; transitionError?: string; errorCode?: string };

type FulfillmentUnion = FulfillmentSuccess | FulfillmentError;

function isFulfillmentSuccess(result: FulfillmentUnion): result is FulfillmentSuccess {
  return result.__typename === 'Fulfillment';
}

type HeadersInit = Record<string, string>;

import { TRANSITION_FULFILLMENT_TO_STATE_MUTATION, UPDATE_FULFILLMENT_TRACKING_MUTATION } from './vendure-queries.js';

export class VendureClient {
  private cookieJar: string | null = null;

  constructor(private readonly adminApiUrl: string) {}

  private getSetCookie(response: Response): string[] {
    const headerApi = response.headers as unknown as { getSetCookie?: () => string[] };
    const cookies = headerApi.getSetCookie?.();
    if (cookies && cookies.length) {
      return cookies;
    }
    const raw = response.headers.get('set-cookie');
    if (!raw) {
      return [];
    }
    return raw.split(/,(?=[^;]+=[^;]+)/g).map((entry) => entry.trim()).filter(Boolean);
  }

  private buildHeaders(extra?: HeadersInit): HeadersInit {
    const headers: HeadersInit = {
      'content-type': 'application/json',
      ...extra,
    };
    if (this.cookieJar) {
      headers['cookie'] = this.cookieJar;
    }
    return headers;
  }

  private updateCookies(setCookieHeader: string[] | undefined) {
    if (!setCookieHeader || setCookieHeader.length === 0) {
      return;
    }
    const cookies = setCookieHeader
      .map((entry) => entry.split(';')[0])
      .filter(Boolean);
    if (cookies.length > 0) {
      this.cookieJar = cookies.join('; ');
    }
  }

  private async graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const response = await fetch(this.adminApiUrl, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify({ query, variables }),
    });

    this.updateCookies(this.getSetCookie(response));

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Vendure request failed with status ${response.status}: ${body}`);
    }

    const payload = (await response.json()) as GraphQLResponse<T>;
    if (payload.errors?.length) {
      throw new Error(payload.errors.map((err) => err.message).join('; '));
    }

    if (!payload.data) {
      throw new Error('Vendure response did not include a data payload.');
    }

    return payload.data;
  }

  async login(username: string, password: string): Promise<void> {
    const response = await fetch(this.adminApiUrl, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify({
        query: LOGIN_MUTATION,
        variables: { username, password },
      }),
    });

    this.updateCookies(this.getSetCookie(response));

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Vendure login failed: ${body}`);
    }

    const payload = (await response.json()) as GraphQLResponse<{
      login: { __typename: string; message?: string };
    }>;

    const result = payload.data?.login;
    if (!result || result.__typename !== 'CurrentUser') {
      throw new Error(result?.message || 'Invalid Vendure admin credentials.');
    }
  }

  async fetchOrders(states: OrderState[], take: number): Promise<OrderSummary[]> {
    const data = await this.graphql<{
      orders: { items: RawOrder[] };
    }>(ORDERS_TO_FULFILL_QUERY, {
      take,
    });

    const summaries = data.orders.items.map((order) => this.toOrderSummary(order));
    // Filter client-side to avoid schema enum issues on some deployments
    const stateSet = new Set(states);
    return summaries.filter((o) => stateSet.has(o.state));
  }

  async fetchOrderByCode(code: string): Promise<OrderSummary | null> {
    const data = await this.graphql<{
      orderByCode: RawOrder | null;
    }>(ORDER_BY_CODE_QUERY, { code });

    if (!data.orderByCode) {
      return null;
    }

    return this.toOrderSummary(data.orderByCode);
  }

  async fetchProductById(id: string): Promise<ProductSummary | null> {
    const data = await this.graphql<{
      product: {
        id: string;
        slug: string;
        name: string;
        description?: string | null;
        assets?: Array<{ preview?: string | null; source?: string | null; type?: string | null }> | null;
        variants?: Array<{ id: string; sku?: string | null; name: string; price?: number; priceWithTax?: number; currencyCode?: string }> | null;
      } | null;
    }>(PRODUCT_BY_ID_QUERY, { id });

    const p = data.product;
    if (!p) {
      return null;
    }

    return {
      id: p.id,
      slug: p.slug,
      name: p.name,
      description: p.description ?? null,
      assets: (p.assets ?? []).map((a) => ({
        preview: a?.preview ?? null,
        source: a?.source ?? null,
        type: a?.type ?? null,
      })),
      variants: (p.variants ?? []).map((v) => ({
        id: v.id,
        sku: v.sku ?? null,
        name: v.name,
        price: Number(v.price ?? 0),
        priceWithTax: Number(v.priceWithTax ?? 0),
        currencyCode: String(v.currencyCode ?? 'USD'),
      })),
    };
  }

  async fetchProductBySlug(slug: string): Promise<ProductSummary | null> {
    const data = await this.graphql<{
      productBySlug: {
        id: string;
        slug: string;
        name: string;
        description?: string | null;
        assets?: Array<{ preview?: string | null; source?: string | null; type?: string | null }> | null;
        variants?: Array<{ id: string; sku?: string | null; name: string; price?: number; priceWithTax?: number; currencyCode?: string }> | null;
      } | null;
    }>(PRODUCT_BY_SLUG_QUERY, { slug });

    const p = data.productBySlug;
    if (!p) {
      return null;
    }

    return {
      id: p.id,
      slug: p.slug,
      name: p.name,
      description: p.description ?? null,
      assets: (p.assets ?? []).map((a) => ({
        preview: a?.preview ?? null,
        source: a?.source ?? null,
        type: a?.type ?? null,
      })),
      variants: (p.variants ?? []).map((v) => ({
        id: v.id,
        sku: v.sku ?? null,
        name: v.name,
        price: Number(v.price ?? 0),
        priceWithTax: Number(v.priceWithTax ?? 0),
        currencyCode: String(v.currencyCode ?? 'USD'),
      })),
    };
  }

  // New: capability check for createFulfillment mutation
  async supportsCreateFulfillment(): Promise<boolean> {
    try {
      const data = await this.graphql<{ __schema: { mutationType?: { fields?: { name: string }[] } } }>(
        `query IntrospectMutations { __schema { mutationType { fields { name } } } }`
      );
      const fields = data.__schema.mutationType?.fields || [];
      const names = fields.map((f) => f.name);
      return names.includes('createFulfillment') || names.includes('addFulfillmentToOrder');
    } catch {
      return false;
    }
  }

  async createFulfillment(input: {
    orderId: string;
    lines: { orderLineId: string; quantity: number }[];
    handlerCode: string;
    method?: string | null;
    trackingCode?: string | null;
    customFields?: Record<string, unknown> | null;
  }): Promise<CreateFulfillmentResult> {
    // Introspect available mutations
    const introspection = await this.graphql<{ __schema: { mutationType?: { fields?: { name: string }[] } } }>(
      `query IntrospectMutations { __schema { mutationType { fields { name } } } }`
    );
    const names = (introspection.__schema.mutationType?.fields || []).map((f) => f.name);

    if (names.includes('createFulfillment')) {
      const data = await this.graphql<{
        createFulfillment: FulfillmentUnion;
      }>(CREATE_FULFILLMENT_MUTATION, {
        input: {
          orderId: input.orderId,
          lines: input.lines,
          handlerCode: input.handlerCode,
          method: input.method ?? undefined,
          trackingCode: input.trackingCode ?? undefined,
          customFields: input.customFields ?? undefined,
        },
      });

      const result = data.createFulfillment;
      if (isFulfillmentSuccess(result)) {
        return {
          success: true,
          fulfillmentId: result.id,
          state: result.state,
          method: result.method ?? null,
        };
      }

      // Retry once with manual-fulfillment if handler is invalid
      const code = (result as any)?.errorCode ?? '';
      const msg = (result as any)?.message ?? '';
      const isInvalidHandler = /INVALID_FULFILLMENT_HANDLER/i.test(String(code)) || /InvalidFulfillmentHandler/i.test(String(msg));
      if (isInvalidHandler) {
        const retry = await this.graphql<{ createFulfillment: FulfillmentUnion }>(CREATE_FULFILLMENT_MUTATION, {
          input: {
            orderId: input.orderId,
            lines: input.lines,
            handlerCode: 'manual-fulfillment',
            method: input.method ?? undefined,
            trackingCode: input.trackingCode ?? undefined,
            customFields: input.customFields ?? undefined,
          },
        });
        const retryResult = retry.createFulfillment;
        if (isFulfillmentSuccess(retryResult)) {
          return {
            success: true,
            fulfillmentId: retryResult.id,
            state: retryResult.state,
            method: retryResult.method ?? null,
          };
        }
        const retryMsg = [retryResult.message, retryResult.transitionError].filter(Boolean).join(' — ');
        return { success: false, message: retryMsg || 'Unknown fulfillment error' };
      }

      const messageParts = [result.message, result.transitionError].filter((part): part is string => Boolean(part));
      return {
        success: false,
        message: messageParts.join(' — ') || 'Unknown fulfillment error',
      };
    }

    if (names.includes('addFulfillmentToOrder')) {
      // Build handler arguments for older API shape
      const handlerArgs: Array<{ name: string; value: string }> = [];
      if (input.method) {
        handlerArgs.push({ name: 'method', value: String(input.method) });
      }
      if (input.trackingCode) {
        handlerArgs.push({ name: 'trackingCode', value: String(input.trackingCode) });
      }

      const data = await this.graphql<{
        addFulfillmentToOrder: FulfillmentUnion;
      }>(ADD_FULFILLMENT_TO_ORDER_MUTATION, {
        input: {
          // orderId: input.orderId, // not part of FulfillOrderInput in legacy API
          lines: input.lines,
          handler: {
            code: input.handlerCode,
            arguments: handlerArgs,
          },
          customFields: input.customFields ?? undefined,
        },
      });

      const result = data.addFulfillmentToOrder;
      if (isFulfillmentSuccess(result)) {
        return {
          success: true,
          fulfillmentId: result.id,
          state: result.state,
          method: result.method ?? null,
        };
      }

      // Retry once with manual-fulfillment if handler is invalid
      const code = (result as any)?.errorCode ?? '';
      const msg = (result as any)?.message ?? '';
      const isInvalidHandler = /INVALID_FULFILLMENT_HANDLER/i.test(String(code)) || /InvalidFulfillmentHandler/i.test(String(msg));
      if (isInvalidHandler) {
        const retryArgs = handlerArgs.slice();
        // keep provided method/trackingCode, only change handler code
        const retry = await this.graphql<{ addFulfillmentToOrder: FulfillmentUnion }>(ADD_FULFILLMENT_TO_ORDER_MUTATION, {
          input: {
            lines: input.lines,
            handler: {
              code: 'manual-fulfillment',
              arguments: retryArgs,
            },
            customFields: input.customFields ?? undefined,
          },
        });
        const retryResult = retry.addFulfillmentToOrder;
        if (isFulfillmentSuccess(retryResult)) {
          return {
            success: true,
            fulfillmentId: retryResult.id,
            state: retryResult.state,
            method: retryResult.method ?? null,
          };
        }
        const retryMsg = [retryResult.message, retryResult.transitionError].filter(Boolean).join(' — ');
        return { success: false, message: retryMsg || 'Unknown fulfillment error' };
      }

      const messageParts = [result.message, result.transitionError].filter((part): part is string => Boolean(part));
      return {
        success: false,
        message: messageParts.join(' — ') || 'Unknown fulfillment error',
      };
    }

    throw new Error('Vendure Admin API does not support fulfillment mutations');
  }

  private toOrderSummary(order: RawOrder): OrderSummary {
    return {
      id: order.id,
      code: order.code,
      state: order.state,
      createdAt: order.createdAt,
      fulfillments: order.fulfillments.map((fulfillment) => ({
        id: fulfillment.id,
        state: fulfillment.state,
        trackingCode: fulfillment.trackingCode ?? null,
      })),
      lines: order.lines.map((line) => ({
        id: line.id,
        quantity: line.quantity,
        productVariant: line.productVariant,
        fulfilledQuantity: (line.fulfillmentLines ?? []).reduce<number>((total, item) => {
          const qty = Number(item?.quantity ?? 0);
          return Number.isFinite(qty) ? total + qty : total;
        }, 0),
      })),
      shippingAddress: order.shippingAddress ?? undefined,
      customer: order.customer ?? undefined,
    };
  }

  async transitionFulfillmentToState(id: string, state: string): Promise<void> {
    const data = await this.graphql<{ transitionFulfillmentToState: { __typename: string; message?: string; transitionError?: string } }>(
      TRANSITION_FULFILLMENT_TO_STATE_MUTATION,
      { id, state }
    );
    const result = data.transitionFulfillmentToState;
    if (result.__typename !== 'Fulfillment') {
      const err = [result.message, result.transitionError].filter(Boolean).join(' — ');
      throw new Error(err || 'Failed to transition fulfillment state');
    }
  }

  async updateFulfillmentTracking(id: string, input: { trackingCode?: string; method?: string }): Promise<void> {
    const data = await this.graphql<{ updateFulfillment: { __typename: string; message?: string } }>(
      UPDATE_FULFILLMENT_TRACKING_MUTATION,
      { input: { id, trackingCode: input.trackingCode, method: input.method } }
    );
    const result = data.updateFulfillment;
    if (result.__typename !== 'Fulfillment') {
      throw new Error(result.message || 'Failed to update fulfillment tracking');
    }
  }
}

export interface OutstandingLine {
  orderLineId: string;
  quantity: number;
  sku: string | null;
  variantName: string;
}

export function getOutstandingFulfillmentLines(order: OrderSummary): OutstandingLine[] {
  return order.lines
    .map<OutstandingLine | null>((line) => {
      const outstanding = line.quantity - line.fulfilledQuantity;
      if (outstanding <= 0) {
        return null;
      }
      return {
        orderLineId: line.id,
        quantity: outstanding,
        sku: line.productVariant.sku ?? null,
        variantName: line.productVariant.name,
      };
    })
    .filter((line): line is OutstandingLine => line !== null);
}
