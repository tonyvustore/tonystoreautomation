# Vendure Fulfillment Automation

Serverless automation (designed for Vercel) that logs into the Vendure admin API, finds orders ready to be fulfilled, optionally creates fulfillments, and reports progress via Telegram.

Note: Cross-sell/upsell endpoints have been moved to `recommendations/`, and GMC (Google Merchant Center) sync has been moved to `gmc/` as separate repos. This folder now only contains Printify fulfillment logic and related webhook.

## Features

- Runs as a Vercel serverless function (`api/fulfill-orders.ts`).
- Authenticates to Vendure Admin GraphQL API using credentials stored in environment variables.
- Fetches orders in target states (default: `PaymentSettled`, `PaymentAuthorized`).
- Calculates outstanding quantities per order line to avoid double fulfillment.
- Supports dry-run mode to test without mutating data.
- Sends step-by-step status updates to Telegram (optional) using bot token and chat ID.
- Optional shared secret to secure endpoint invocations.

## Project structure

```
automations/
├── api/
│   └── fulfill-orders.ts     # Serverless function entrypoint
├── src/
│   ├── config.ts             # Environment-driven configuration loader
│   └── lib/
│       ├── telegram.ts       # Telegram notification helper
│       └── vendure-client.ts # Minimal Vendure admin GraphQL client
├── package.json
├── tsconfig.json
└── README.md (this file)
```

## Environment variables

Set the following in your Vercel project or local `.env` when running `vercel dev`:

| Variable | Required | Description |
|----------|----------|-------------|
| `VENDURE_ADMIN_API_URL` | ✅ | Vendure admin GraphQL endpoint (e.g. `https://example.com/admin-api`). |
| `VENDURE_ADMIN_EMAIL` | ✅ | Vendure admin identifier / email. |
| `VENDURE_ADMIN_PASSWORD` | ✅ | Vendure admin password. |
| `FULFILLMENT_HANDLER_CODE` | ❌ | Vendure fulfillment handler code to use. Defaults to `manual-fulfillment`. |
| `FULFILLMENT_MAX_ORDERS` | ❌ | Max orders processed per run (default `20`). |
| `FULFILLMENT_DRY_RUN` | ❌ | Set to `true` to simulate without creating fulfillments. |
| `TELEGRAM_BOT_TOKEN` | ❌ | Telegram bot token for notifications. Leave unset to disable Telegram. |
| `TELEGRAM_CHAT_ID` | ❌ | Chat ID to receive Telegram messages. Required if bot token provided. |
| `AUTOMATION_JOB_SECRET` | ❌ | Shared secret required to trigger function. Provide via query `?secret=` or header `x-automation-secret`. |
| `PRINTIFY_API_TOKEN` | ❌* | Required when Printify integration is enabled. Personal access token from Printify. |
| `PRINTIFY_SHOP_ID` | ❌* | Printify shop ID receiving the orders. |
| `PRINTIFY_API_BASE_URL` | ❌ | Override base URL for Printify API (defaults to `https://api.printify.com/v1`). |
| `PRINTIFY_API_MOCK` | ❌ | Set to `true` to simulate Printify calls without hitting the API (also auto-enabled during dry-run). |
| `PRINTIFY_SHIPPING_METHOD` | ❌ | Numeric shipping method ID to pass when creating Printify orders. |
| `PRINTIFY_PRODUCT_MAPPING` | ❌* | JSON mapping from Vendure SKU to `{ "productId": number, "variantId": number }`. Required when Printify integration is active. |
| `PRINTIFY_WEBHOOK_SECRET` | ❌ | Shared secret to verify incoming Printify webhook payloads. |

>  Printify variables marked with ❌* are required only if you intend to push orders to Printify. Alternatively set `PRINTIFY_API_MOCK=true` to test without credentials.

> ⚠️ Do **not** commit secrets. Configure them via Vercel project settings.

## Local development

```bash
cd automations
npm install
npm run dev
```

This uses `vercel dev` to run the serverless function locally. You can invoke it with:

```bash
curl -X POST "http://localhost:3000/api/fulfill-orders" \
  -H "Content-Type: application/json" \
  -H "x-automation-secret: $AUTOMATION_JOB_SECRET" \
  -d '{}'
```

## Deployment (Vercel)

1. Push the `automations` folder to your repository.
2. Create a new Vercel project pointing to the repo.
3. Set build command to `npm install && npm run lint` (optional) and output directory `.` (default for serverless).
4. Configure environment variables as listed above.
5. Deploy. The function will be available at `https://<your-vercel-app>.vercel.app/api/fulfill-orders`.

## Telegram notification example

```
Automation: Fulfillment job starting
Automation: Order fulfilled
Order ORD123 → fulfillment FULF789 (Fulfilled)
Automation: Fulfillment job completed
Successful fulfillments: 1
```

## Notes

- The script assumes the specified fulfillment handler handles all required shipping logic.
- Extend `STATES_TO_FULFILL` in `api/fulfill-orders.ts` if you need additional states.
- Add tracking codes or custom fields by adjusting the payload in `VendureClient.createFulfillment` calls.
- Consider scheduling the endpoint (e.g. via Vercel Cron) for periodic execution.
- When Printify integration is enabled, each Vendure order is replicated to Printify before calling Vendure's fulfillment mutation. Failures to create the Printify order will be reported and the Vendure fulfillment is skipped for that order.
- Set `PRINTIFY_API_MOCK=true` (or enable `FULFILLMENT_DRY_RUN`) to exercise the flow without contacting Printify. Mock responses include the generated ID in Telegram logs.
