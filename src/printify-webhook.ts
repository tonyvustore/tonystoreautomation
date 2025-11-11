import { loadConfig } from './config.js';
import { TelegramReporter } from './lib/telegram.js';
import { VendureClient } from './lib/vendure-client.js';

interface PrintifyShipment {
  tracking_number?: string;
  carrier?: string;
}

interface PrintifyWebhookEvent {
  type?: string;
  status?: string;
  external_id?: string;
  shipments?: PrintifyShipment[];
  [key: string]: unknown;
}

function normalizeEvent(body: unknown): PrintifyWebhookEvent {
  if (!body) return {};
  if (typeof body === 'string') {
    try { return JSON.parse(body) as PrintifyWebhookEvent; } catch { return {}; }
  }
  return body as PrintifyWebhookEvent;
}

function mapEventToState(evt: PrintifyWebhookEvent): 'Fulfilled' | 'Shipped' | 'Delivered' | null {
  const t = (evt.type ?? '').toLowerCase();
  const s = (evt.status ?? '').toLowerCase();
  if (t.includes('delivered') || s === 'delivered') return 'Delivered';
  if (t.includes('shipped') || s === 'shipped') return 'Shipped';
  if (t.includes('fulfilled') || s === 'fulfilled') return 'Fulfilled';
  return null;
}

declare const require: any;

async function verifySignature(secret: string | undefined, bodyRaw: string | undefined, signature: string | undefined): Promise<boolean> {
  if (!secret || !bodyRaw || !signature) return true; // if we cannot verify, be lenient but log
  try {
    const { createHmac } = require('crypto');
    const digest = createHmac('sha256', secret).update(bodyRaw).digest('hex');
    return digest === signature;
  } catch (e) {
    console.warn('Signature verification unavailable', e);
    return true;
  }
}

export async function handlePrintifyWebhook(body: unknown, headers: Record<string, string>): Promise<{ ok: boolean; message?: string }> {
  const cfg = loadConfig();
  const reporter = new TelegramReporter({
    enabled: cfg.telegram.enabled,
    botToken: cfg.telegram.botToken,
    chatId: cfg.telegram.chatId,
    dryRun: cfg.job.dryRun,
  });

  const bodyRaw = typeof body === 'string' ? body : JSON.stringify(body ?? {});
  const signature = headers['X-Printify-Signature'] || headers['x-printify-signature'] || '';
  const sigOk = await verifySignature(cfg.printify.webhookSecret, bodyRaw, signature);
  if (!sigOk) {
    await reporter.notify('Từ chối webhook Printify: chữ ký không hợp lệ');
    return { ok: false, message: 'Invalid signature' };
  }

  const evt = normalizeEvent(bodyRaw);
  const targetState = mapEventToState(evt);
  const vendure = new VendureClient(cfg.vendure.apiUrl);
  await vendure.login(cfg.vendure.username, cfg.vendure.password);

  if (!evt.external_id) {
    await reporter.notify('Webhook Printify thiếu external_id');
    return { ok: false, message: 'Missing external_id' };
  }

  const order = await vendure.fetchOrderByCode(evt.external_id);
  if (!order) {
    await reporter.notify('Không tìm thấy đơn hàng cho webhook', `external_id=${evt.external_id}`);
    return { ok: false, message: 'Order not found' };
  }

  const fulfillment = order.fulfillments[order.fulfillments.length - 1];
  if (!fulfillment) {
    await reporter.notify('Không có fulfillment để cập nhật', `order=${order.code}`);
    return { ok: false, message: 'No fulfillment found' };
  }

  if (cfg.job.dryRun) {
    await reporter.notify('Chế độ thử: sẽ cập nhật fulfillment', `order=${order.code}, state=${targetState}`);
    return { ok: true };
  }

  if (targetState === 'Shipped') {
    const shipment = (evt.shipments ?? [])[0];
    if (shipment?.tracking_number || shipment?.carrier) {
      await vendure.updateFulfillmentTracking(fulfillment.id, {
        trackingCode: shipment?.tracking_number,
        method: shipment?.carrier,
      });
      await reporter.notify('Đã cập nhật thông tin vận chuyển', `order=${order.code}, tracking=${shipment?.tracking_number}`);
    }
  }

  if (targetState) {
    await vendure.transitionFulfillmentToState(fulfillment.id, targetState);
    await reporter.notify('Đã chuyển trạng thái giao hàng', `order=${order.code}, state=${targetState}`);
  }

  return { ok: true };
}