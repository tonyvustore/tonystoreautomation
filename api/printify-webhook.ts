import crypto from 'crypto';

import { loadConfig } from '../src/config.js';
import { TelegramReporter } from '../src/lib/telegram.js';
import { VendureClient, OrderSummary } from '../src/lib/vendure-client.js';

const PRINTIFY_EVENT_MAP: Record<string, FulfillmentUpdate> = {
  'order:sent-to-production': { targetState: 'Fulfilled' },
  'order:shipment:created': { targetState: 'Shipped' },
  'order:shipment:delivered': { targetState: 'Delivered' },
};

type FulfillmentState = 'Created' | 'Pending' | 'Fulfilled' | 'Cancelled' | 'Shipped' | 'Delivered';

type FulfillmentUpdate = {
  targetState: FulfillmentState;
  tracking?: { carrier?: string | null; code?: string | null };
};

type RequestLike = {
  method?: string;
  headers: Record<string, string | string[]>;
  body?: string | Buffer | null;
};

type ResponseLike = {
  status: (code: number) => ResponseLike;
  json: (body: unknown) => void;
  setHeader: (name: string, value: string) => void;
};

type PrintifyWebhookPayload = {
  event: string;
  data?: {
    id?: string;
    external_id?: string;
    shipments?: Array<{
      carrier?: string;
      tracking_number?: string;
    }>;
  };
};

type PrintifyHeaders = {
  'printify-signature'?: string;
};

function getHeader(headers: Record<string, string | string[]>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function verifySignature(rawBody: string, secret: string | undefined, signature?: string): boolean {
  if (!secret) {
    return true;
  }
  if (!signature) {
    return false;
  }
  const hmac = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(hmac, 'hex'), Buffer.from(signature, 'hex'));
}

async function transitionFulfillments(
  vendure: VendureClient,
  order: OrderSummary,
  targetState: FulfillmentState,
  tracking: FulfillmentUpdate['tracking'] | undefined,
): Promise<string | null> {
  const latest = order.fulfillments[order.fulfillments.length - 1];
  if (!latest) {
    return null;
  }

  try {
    await vendure.transitionFulfillmentToState(latest.id, targetState);
  } catch (error) {
    throw new Error(`Vendure transition failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (tracking?.code) {
    try {
      await vendure.updateFulfillmentTracking(latest.id, {
        trackingCode: tracking.code,
        method: tracking.carrier ?? undefined,
      });
    } catch (error) {
      throw new Error(`Vendure tracking update failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return latest.id;
}

export default async function handler(req: RequestLike, res: ResponseLike) {
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const rawBody = typeof req.body === 'string' || Buffer.isBuffer(req.body) ? req.body.toString() : '';

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }

  const reporter = new TelegramReporter({
    enabled: config.telegram.enabled,
    botToken: config.telegram.botToken,
    chatId: config.telegram.chatId,
    dryRun: false,
  });

  const signature = getHeader(req.headers, 'printify-signature');
  const bypassSecret = getHeader(req.headers, 'x-automation-secret');
  const hasBypass = Boolean(config.job.secret && bypassSecret && bypassSecret === config.job.secret);

  if (!hasBypass && !verifySignature(rawBody, config.printify.webhookSecret, signature)) {
    await reporter.notify('Printify webhook rejected', 'Invalid signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  let payload: PrintifyWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as PrintifyWebhookPayload;
  } catch (error) {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }

  if (!payload.event || !payload.data?.external_id) {
    return res.status(400).json({ error: 'Missing event or external_id' });
  }

  const eventConfig = PRINTIFY_EVENT_MAP[payload.event];
  if (!eventConfig) {
    return res.status(200).json({ ignored: true });
  }

  const vendure = new VendureClient(config.vendure.apiUrl);

  try {
    await vendure.login(config.vendure.username, config.vendure.password);
    const order = await vendure.fetchOrderByCode(payload.data.external_id);
    if (!order) {
      await reporter.notify('Bỏ qua webhook Printify', `Không tìm thấy đơn ${payload.data.external_id}.`);
      return res.status(404).json({ error: 'Order not found' });
    }

    const trackingInfo = payload.data.shipments?.[0];
    const tracking = trackingInfo
      ? {
          carrier: trackingInfo.carrier ?? undefined,
          code: trackingInfo.tracking_number ?? undefined,
        }
      : undefined;

    const fulfillmentId = await transitionFulfillments(vendure, order, eventConfig.targetState, tracking);
    await reporter.notify(
      hasBypass ? 'Đã xử lý webhook Printify (bỏ qua chữ ký bằng secret)' : 'Đã xử lý webhook Printify',
      `Đơn ${order.code} → fulfillment ${fulfillmentId ?? 'N/A'} chuyển sang trạng thái ${eventConfig.targetState}.`,
    );

    return res.status(200).json({ success: true, bypass: hasBypass });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await reporter.notify('Xử lý webhook Printify thất bại', message);
    return res.status(500).json({ error: message });
  }
}
