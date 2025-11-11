import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

// dotenv configured above to load .env.local or .env

const ENV: Record<string, string | undefined> =
  (globalThis as any)?.process?.env ?? {};

export interface AutomationConfig {
  vendure: {
    apiUrl: string;
    username: string;
    password: string;
    fulfillmentHandlerCode: string;
    fulfillmentMethod: string;
    maxOrdersPerRun: number;

  };
  telegram: {
    botToken: string;
    chatId: string;
    enabled: boolean;
  };
  job: {
    dryRun: boolean;
    secret?: string;
  };
  printify: {
    enabled: boolean;
    apiToken: string;
    shopId: string;
    shippingMethod?: number;
    webhookSecret?: string;
    apiBaseUrl: string;
    mockApi: boolean;
    enableWebhook: boolean;
    productMapping: Record<
      string,
      {
        productId: number;
        variantId: number;
      }
    >;
  };
}

function requireEnv(key: string): string {
  const value = ENV[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optionalEnv(key: string): string | undefined {
  const value = ENV[key];
  return value && value.length > 0 ? value : undefined;
}

function loadMappingFromCsv(csvPath: string): AutomationConfig['printify']['productMapping'] {
  const resolved = path.isAbsolute(csvPath) ? csvPath : path.join(process.cwd(), csvPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`PRINTIFY_PRODUCT_MAPPING_CSV not found at path: ${resolved}`);
  }
  const raw = fs.readFileSync(resolved, 'utf8');
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const mapping: AutomationConfig['printify']['productMapping'] = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip header if present
    if (i === 0 && /sku/i.test(line) && /product/i.test(line) && /variant/i.test(line)) {
      continue;
    }
    const parts = line.split(',').map((p) => p.trim());
    if (parts.length < 3) {
      throw new Error(`Invalid CSV format at line ${i + 1}: expected sku,productId,variantId`);
    }
    const [sku, productIdStr, variantIdStr] = parts;
    const productId = Number(productIdStr);
    const variantId = Number(variantIdStr);
    if (!sku) {
      throw new Error(`CSV line ${i + 1}: missing sku`);
    }
    if (!Number.isFinite(productId) || !Number.isFinite(variantId)) {
      throw new Error(`CSV line ${i + 1}: productId and variantId must be numbers`);
    }
    mapping[sku] = { productId, variantId };
  }

  return mapping;
}

export function loadConfig(): AutomationConfig {
  const dryRun = (ENV['FULFILLMENT_DRY_RUN'] ?? '').toLowerCase() === 'true';
  const maxOrdersPerRun = Number(ENV['FULFILLMENT_MAX_ORDERS'] ?? '20');
  if (!Number.isFinite(maxOrdersPerRun) || maxOrdersPerRun <= 0) {
    throw new Error('FULFILLMENT_MAX_ORDERS must be a positive number if provided');
  }

  const botToken = optionalEnv('TELEGRAM_BOT_TOKEN');
  const chatId = optionalEnv('TELEGRAM_CHAT_ID');
  const telegramEnabled = Boolean(botToken && chatId);

  const printifyToken = optionalEnv('PRINTIFY_API_TOKEN');
  const printifyShopId = optionalEnv('PRINTIFY_SHOP_ID');
  const printifyApiBaseUrl = optionalEnv('PRINTIFY_API_BASE_URL') ?? 'https://api.printify.com/v1';
  const printifyMock = (ENV['PRINTIFY_API_MOCK'] ?? '').toLowerCase() === 'true';
  const printifyWebhookFlag = (ENV['PRINTIFY_WEBHOOK_ENABLED'] ?? '').toLowerCase() === 'true';
  const printifyEnabled = printifyMock || Boolean(printifyToken && printifyShopId);
  const printifyShippingMethod = optionalEnv('PRINTIFY_SHIPPING_METHOD');
  const printifyWebhookSecret = optionalEnv('PRINTIFY_WEBHOOK_SECRET');

  // Load mapping: CSV takes precedence over JSON env
  const mappingCsvPath = optionalEnv('PRINTIFY_PRODUCT_MAPPING_CSV');
  let productMapping: AutomationConfig['printify']['productMapping'] = {};

  if (mappingCsvPath) {
    productMapping = loadMappingFromCsv(mappingCsvPath);
  } else {
    const mappingRaw = optionalEnv('PRINTIFY_PRODUCT_MAPPING') ?? '{}';
    try {
      const parsed = JSON.parse(mappingRaw) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object') {
        const validated: AutomationConfig['printify']['productMapping'] = {};
        for (const [key, value] of Object.entries(parsed)) {
          if (
            value &&
            typeof value === 'object' &&
            'productId' in value &&
            'variantId' in value &&
            typeof (value as any).productId === 'number' &&
            typeof (value as any).variantId === 'number'
          ) {
            validated[key] = {
              productId: (value as any).productId,
              variantId: (value as any).variantId,
            };
          }
        }
        productMapping = validated;
      }
    } catch (error) {
      throw new Error(`PRINTIFY_PRODUCT_MAPPING must be valid JSON. ${(error as Error).message}`);
    }
  }

  if (printifyEnabled && Object.keys(productMapping).length === 0) {
    throw new Error('Printify product mapping is required when Printify integration is enabled. Provide PRINTIFY_PRODUCT_MAPPING_CSV or PRINTIFY_PRODUCT_MAPPING.');
  }

  return {
    vendure: {
      apiUrl: requireEnv('VENDURE_ADMIN_API_URL'),
      username: requireEnv('VENDURE_ADMIN_EMAIL'),
      password: requireEnv('VENDURE_ADMIN_PASSWORD'),
      fulfillmentHandlerCode: ENV['FULFILLMENT_HANDLER_CODE'] ?? 'manual-fulfillment',
      maxOrdersPerRun,
      fulfillmentMethod: 'printify',
    },
    telegram: {
      botToken: botToken ?? '',
      chatId: chatId ?? '',
      enabled: telegramEnabled,
    },
    job: {
      dryRun,
      secret: optionalEnv('AUTOMATION_JOB_SECRET'),
    },
    printify: {
      enabled: printifyEnabled,
      apiToken: printifyToken ?? '',
      shopId: printifyShopId ?? '',
      shippingMethod: printifyShippingMethod ? Number(printifyShippingMethod) : undefined,
      webhookSecret: printifyWebhookSecret,
      apiBaseUrl: printifyApiBaseUrl,
      mockApi: printifyMock,
      enableWebhook: printifyWebhookFlag,
      productMapping,
    },
  };
}

const envLocal = path.join(process.cwd(), '.env.local');
const envDefault = path.join(process.cwd(), '.env');
if (fs.existsSync(envLocal)) {
  dotenv.config({ path: envLocal });
} else if (fs.existsSync(envDefault)) {
  dotenv.config({ path: envDefault });
}
