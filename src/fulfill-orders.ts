import { loadConfig } from './config.js';
import { PrintifyClient, CreatePrintifyOrderInput, PrintifyLineItemInput } from './lib/printify-client.js';
import { TelegramReporter } from './lib/telegram.js';
import { VendureClient, OrderSummary, getOutstandingFulfillmentLines, OutstandingLine } from './lib/vendure-client.js';

function splitName(fullName?: string | null): { first: string; last: string } {
  const name = (fullName ?? '').trim();
  if (!name) return { first: 'Customer', last: '' };
  const parts = name.split(/\s+/);
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

function buildPrintifyLineItems(order: OrderSummary, mapping: Record<string, { productId: number; variantId: number }>): PrintifyLineItemInput[] {
  const outstanding = getOutstandingFulfillmentLines(order);
  const result: PrintifyLineItemInput[] = [];
  for (const line of outstanding) {
    const sku = line.sku ?? line.variantName;
    const map = sku ? mapping[sku] : undefined;
    if (!map) {
      throw new Error(`No Printify mapping found for SKU '${sku}'`);
    }
    result.push({ productId: map.productId, variantId: map.variantId, quantity: line.quantity });
  }
  return result;
}

async function fulfillOrder(
  vendure: VendureClient,
  printify: PrintifyClient | null,
  reporter: TelegramReporter,
  cfg: ReturnType<typeof loadConfig>,
  order: OrderSummary
): Promise<void> {
  const outstanding = getOutstandingFulfillmentLines(order);
  if (outstanding.length === 0) {
    await reporter.notify(`Skip order ${order.code}`, 'No outstanding lines to fulfill');
    return;
  }

  const linesForVendure = outstanding.map((l: OutstandingLine) => ({ orderLineId: l.orderLineId, quantity: l.quantity }));

  let printifyOrderId: string | undefined;
  if (cfg.printify.enabled && printify) {
    const missingSkus = outstanding
      .map((l: OutstandingLine) => l.sku ?? l.variantName)
      .filter((sku: string) => !cfg.printify.productMapping[sku]);
    if (missingSkus.length > 0) {
      await reporter.notify(
        `Thiếu mapping Printify cho order ${order.code}`,
        `SKUs thiếu: ${missingSkus.join(', ')}`
      );
      return;
    }

    const { first, last } = splitName(order.shippingAddress?.fullName);
    const address = {
      first_name: first,
      last_name: last,
      email: order.customer?.emailAddress || 'unknown@example.com',
      phone: order.shippingAddress?.phoneNumber || '',
      country: order.shippingAddress?.countryCode || 'US',
      region: order.shippingAddress?.provinceCode || order.shippingAddress?.province || '',
      address1: order.shippingAddress?.streetLine1 || '',
      address2: order.shippingAddress?.streetLine2 || '',
      city: order.shippingAddress?.city || '',
      zip: order.shippingAddress?.postalCode || '',
    };

    const line_items = buildPrintifyLineItems(order, cfg.printify.productMapping);
    const input: CreatePrintifyOrderInput = {
      external_id: order.code,
      label: `Order ${order.code}`,
      line_items,
      shipping_method: cfg.printify.shippingMethod,
      send_shipping_notification: false,
      address_to: address,
      metadata: {
        vendure_order_id: order.id,
      },
    };

    await reporter.notify(`Create Printify draft order for ${order.code}`);
    const resp = await printify.createOrder(input);
    printifyOrderId = resp.id;
    await reporter.notify(`Printify draft order created for ${order.code}`, `Printify ID: ${resp.id}`);
  }

  if (cfg.job.dryRun) {
    await reporter.notify(`Dry-run: would create Vendure fulfillment for ${order.code}`);
    return;
  }

  await reporter.notify(`Create Vendure fulfillment for ${order.code}`);
  const created = await vendure.createFulfillment({
    orderId: order.id,
    lines: linesForVendure,
    handlerCode: cfg.vendure.fulfillmentHandlerCode,
    method: printifyOrderId ? 'Printify' : 'Manual',
    trackingCode: undefined,
  });

  if (!created.success) {
    throw new Error(`Vendure fulfillment failed: ${created.message}`);
  }

  await reporter.notify(
    `Vendure fulfillment created for ${order.code}`,
    `Fulfillment ID: ${created.fulfillmentId}, state: ${created.state}`
  );
}

export async function runFulfillOrders(): Promise<void> {
  const cfg = loadConfig();
  const reporter = new TelegramReporter({
    enabled: cfg.telegram.enabled,
    botToken: cfg.telegram.botToken,
    chatId: cfg.telegram.chatId,
    dryRun: cfg.job.dryRun,
  });

  const vendure = new VendureClient(cfg.vendure.apiUrl);
  await vendure.login(cfg.vendure.username, cfg.vendure.password);

  const printify = cfg.printify.enabled
    ? new PrintifyClient({ apiToken: cfg.printify.apiToken, shopId: cfg.printify.shopId, baseUrl: cfg.printify.apiBaseUrl, mock: cfg.printify.mockApi })
    : null;

  await reporter.notify('Bắt đầu chạy xử lý giao hàng');
  try {
    const states: Array<'PaymentSettled' | 'PartiallyFulfilled'> = ['PaymentSettled', 'PartiallyFulfilled'];
    const orders = await vendure.fetchOrders(states, cfg.vendure.maxOrdersPerRun);

    for (const order of orders) {
      try {
        await fulfillOrder(vendure, printify, reporter, cfg, order);
      } catch (err) {
        await reporter.notify(
          `Lỗi khi xử lý đơn hàng ${order.code}`,
          (err as Error).message
        );
      }
    }

    await reporter.notify('Hoàn thành chạy xử lý giao hàng');
  } catch (err) {
    await reporter.notify('Chạy xử lý giao hàng thất bại', (err as Error).message);
    throw err;
  }
}