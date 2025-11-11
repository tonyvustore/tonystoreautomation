import { loadConfig } from '../src/config.js';
import { TelegramReporter } from '../src/lib/telegram.js';
import { VendureClient, OrderState, getOutstandingFulfillmentLines } from '../src/lib/vendure-client.js';
import { PrintifyClient, PrintifyLineItemInput } from '../src/lib/printify-client.js';

const STATES_TO_FULFILL: OrderState[] = ['PaymentSettled', 'PaymentAuthorized'];

type RequestLike = {
  method?: string;
  query: Record<string, string | string[]>;
  headers: Record<string, string | string[]>;
};

type ResponseLike = {
  status: (code: number) => ResponseLike;
  json: (body: unknown) => void;
  setHeader: (name: string, value: string) => void;
};

function splitFullName(fullName?: string | null): { firstName: string; lastName: string } {
  if (!fullName) {
    return { firstName: 'Customer', lastName: 'Unknown' };
  }
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return { firstName: 'Customer', lastName: 'Unknown' };
  }
  if (parts.length === 1) {
    return { firstName: parts[0], lastName: 'Customer' };
  }
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(' '),
  };
}

type PrintifyProductMapping = Record<string, { productId: number; variantId: number }>;

function buildPrintifyLineItems(
  outstanding: ReturnType<typeof getOutstandingFulfillmentLines>,
  productMapping: PrintifyProductMapping,
): PrintifyLineItemInput[] {
  return outstanding.map((line): PrintifyLineItemInput => {
    const sku = line.sku ?? '';
    const mapping = productMapping[sku];
    if (!mapping) {
      throw new Error(`Missing PRINTIFY_PRODUCT_MAPPING entry for SKU "${sku}"`);
    }
    return {
      productId: mapping.productId,
      variantId: mapping.variantId,
      quantity: line.quantity,
      metadata: {
        vendureOrderLineId: line.orderLineId,
        sku,
        variantName: line.variantName,
      },
    };
  });
}

function validateSecret(req: RequestLike, expected?: string): boolean {
  if (!expected) {
    return true;
  }
  const provided =
    (typeof req.query.secret === 'string' ? req.query.secret : undefined) ||
    (typeof req.headers['x-automation-secret'] === 'string' ? req.headers['x-automation-secret'] : undefined);
  return provided === expected;
}

export default async function handler(req: RequestLike, res: ResponseLike) {
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }

  if (!validateSecret(req, config.job.secret)) {
    return res.status(401).json({ error: 'Invalid or missing automation secret.' });
  }

  const reporter = new TelegramReporter({
    enabled: config.telegram.enabled,
    botToken: config.telegram.botToken,
    chatId: config.telegram.chatId,
    dryRun: config.job.dryRun,
  });

  const printify = config.printify.enabled
    ? new PrintifyClient({
        apiToken: config.printify.apiToken,
        shopId: config.printify.shopId,
        baseUrl: config.printify.apiBaseUrl,
        mock: config.printify.mockApi || config.job.dryRun,
      })
    : null;

  const vendure = new VendureClient(config.vendure.apiUrl);

  try {
    await reporter.notify('Fulfillment job starting');
    await vendure.login(config.vendure.username, config.vendure.password);

    // New: detect whether the current Admin API supports Vendure fulfillment
    const canVendureFulfill = await vendure.supportsCreateFulfillment();
    if (!canVendureFulfill) {
      await reporter.notify(
        'Vendure fulfillment unsupported on current Admin API',
        'Will skip Vendure fulfillment and continue with Printify (if enabled)'
      );
    }

    const orders = await vendure.fetchOrders(STATES_TO_FULFILL, config.vendure.maxOrdersPerRun);

    if (orders.length === 0) {
      await reporter.notify('Fulfillment job completed', 'No eligible orders found.');
      return res.status(200).json({ updatedOrders: 0, message: 'No eligible orders found.' });
    }

    let successCount = 0;
    const failures: { code: string; reason: string }[] = [];
    const dryRunNotes: string[] = [];

    for (const order of orders) {
      const outstanding = getOutstandingFulfillmentLines(order);

      if (outstanding.length === 0) {
        continue;
      }

      if (config.job.dryRun) {
        dryRunNotes.push(`Order ${order.code} would fulfill ${outstanding.length} line(s).`);
        continue;
      }

      if (printify) {
        try {
          const address = order.shippingAddress;
          if (!address) {
            throw new Error('Order missing shipping address');
          }

          const { firstName, lastName } = splitFullName(address.fullName);
          const email = order.customer?.emailAddress ?? 'no-reply@example.com';

          const lineItems = buildPrintifyLineItems(outstanding, config.printify.productMapping);

          const printifyOrder = await printify.createOrder({
            external_id: order.code,
            label: `Vendure order ${order.code}`,
            address_to: {
              first_name: firstName,
              last_name: lastName,
              email,
              phone: address.phoneNumber ?? undefined,
              country: address.countryCode ?? 'US',
              region: address.province ?? undefined,
              address1: address.streetLine1 ?? 'Unknown address line 1',
              address2: address.streetLine2 ?? undefined,
              city: address.city ?? 'Unknown city',
              zip: address.postalCode ?? '00000',
            },
            shipping_method: config.printify.shippingMethod,
            send_shipping_notification: false,
            line_items: lineItems,
            metadata: {
              vendureOrderId: order.id,
              vendureOrderCode: order.code,
            },
          });

          await reporter.notify(
            'Printify order created',
            `Order ${order.code} → Printify ${printifyOrder.id} (${printifyOrder.status})`,
          );
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          failures.push({ code: order.code, reason });
          await reporter.notify('Printify order creation failed', `Order ${order.code}: ${reason}`);
          continue;
        }
      }

      // If the Admin API lacks createFulfillment, skip Vendure fulfillment cleanly
      if (!canVendureFulfill) {
        failures.push({ code: order.code, reason: 'Vendure Admin API does not support createFulfillment' });
        await reporter.notify(
          'Order fulfillment skipped',
          `Order ${order.code}: Vendure API lacks fulfillment mutations`
        );
        continue;
      }

      const lines = outstanding.map(
        (line): { orderLineId: string; quantity: number } => ({
          orderLineId: line.orderLineId,
          quantity: line.quantity,
        }),
      );

      let result;
      try {
        result = await vendure.createFulfillment({
          orderId: order.id,
          lines,
          method: config.vendure.fulfillmentMethod,
          handlerCode: config.vendure.fulfillmentHandlerCode,
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        failures.push({ code: order.code, reason });
        await reporter.notify('Order fulfillment failed', `Order ${order.code}: ${reason}`);
        continue;
      }

      if (result.success) {
        successCount += 1;
        await reporter.notify('Order fulfilled', `Order ${order.code} → fulfillment ${result.fulfillmentId} (${result.state})`);
      } else {
        const reason = result.message ?? 'Unknown error';
        failures.push({ code: order.code, reason });
        await reporter.notify('Order fulfillment failed', `Order ${order.code}: ${reason}`);
      }
    }

    if (config.job.dryRun) {
      await reporter.notify('Fulfillment job completed (dry-run)', dryRunNotes.join('\n') || 'No pending lines.');
      return res.status(200).json({ dryRun: true, notes: dryRunNotes });
    }

    const summaryLines: string[] = [`Successful fulfillments: ${successCount}`];
    if (failures.length > 0) {
      summaryLines.push(`Thất bại: ${failures.length}`);
      summaryLines.push(
        failures
          .map((failure) => `• ${failure.code}: ${failure.reason}`)
          .join('\n'),
      );
    }

    await reporter.notify('Hoàn thành tác vụ giao hàng', summaryLines.join('\n'));

    return res.status(200).json({
      updatedOrders: successCount,
      failures,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await reporter.notify('Tác vụ giao hàng thất bại', message);
    return res.status(500).json({ error: message });
  }
}
