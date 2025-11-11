import { loadConfig } from '../src/config.js';
import { VendureClient } from '../src/lib/vendure-client.js';
import { insertProduct } from '../src/lib/gmc-client.js';
import { TelegramReporter } from '../src/lib/telegram.js';

interface SyncRequestBody {
  id?: string;
  slug?: string;
  linkOverride?: string; // optional storefront link override
  brand?: string; // optional brand override
}

function escapeHtml(input: string): string {
  return String(input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export default async function handler(req: Request): Promise<Response> {
  const cfg = loadConfig();
  const reporter = new TelegramReporter({
    enabled: cfg.telegram.enabled,
    botToken: cfg.telegram.botToken,
    chatId: cfg.telegram.chatId,
    dryRun: cfg.job.dryRun,
  });

  try {
    if (req.method !== 'POST') {
      return new Response(JSON.stringify({ ok: false, error: 'Phương thức không hỗ trợ' }), { status: 405 });
    }

    const secret = req.headers.get('x-automation-secret');
    if (cfg.job.secret && secret !== cfg.job.secret) {
      await reporter.notify('❌ Webhook bị từ chối', `Lý do: sai hoặc thiếu x-automation-secret`);
      return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), { status: 401 });
    }

    const body = (await req.json()) as SyncRequestBody;
    const { id, slug, linkOverride, brand } = body;

    if (!id && !slug) {
      await reporter.notify('❌ Yêu cầu không hợp lệ', `Thiếu id hoặc slug của sản phẩm`);
      return new Response(JSON.stringify({ ok: false, error: 'Thiếu id hoặc slug' }), { status: 400 });
    }

    await reporter.notify('🚀 Bắt đầu đồng bộ sản phẩm lên GMC', `Nguồn: ${id ? 'id ' + escapeHtml(id) : 'slug ' + escapeHtml(String(slug))}`);

    const vendure = new VendureClient(cfg.vendure.apiUrl);
    await vendure.login(cfg.vendure.username, cfg.vendure.password);

    const product = id ? await vendure.fetchProductById(id) : await vendure.fetchProductBySlug(String(slug));
    if (!product) {
      await reporter.notify('❌ Không tìm thấy sản phẩm', `${id ? 'id ' + escapeHtml(id) : 'slug ' + escapeHtml(String(slug))}`);
      return new Response(JSON.stringify({ ok: false, error: 'Product not found' }), { status: 404 });
    }

    const storefrontBase = process.env.STORE_FRONT_BASE_URL || '';
    const defaultBrand = brand || process.env.DEFAULT_BRAND || undefined;

    // Build primary and additional image links
    const assetUrls = (product.assets || [])
      .map((a) => (a.preview || a.source || '')?.toString())
      .filter((u) => typeof u === 'string' && u.length > 0);
    const imageLink = assetUrls[0] || '';
    const additionalImageLinks = assetUrls.slice(1);

    const variant = product.variants[0];
    const priceValue = variant?.priceWithTax ?? variant?.price ?? 0;
    const currency = variant?.currencyCode ?? 'USD';
    const link = linkOverride || (storefrontBase ? `${storefrontBase}/product/${product.slug}` : `https://example.com/product/${product.slug}`);

    const offerId = product.slug || product.id;

    const mpn = variant?.sku || undefined;
    const googleProductCategory = process.env.GMC_PRODUCT_CATEGORY || undefined;

    if (cfg.job.dryRun) {
      await reporter.notify(
        '🧪 Chế độ thử',
        `Sẽ đồng bộ lên GMC: ${escapeHtml(
          JSON.stringify(
            {
              offerId,
              title: product.name,
              price: { value: String((priceValue / 100).toFixed(2)), currency },
              link,
              imageLink,
              additionalImageLinks,
              mpn,
              googleProductCategory,
            },
            null,
            2,
          ),
        )}`,
      );
      return new Response(JSON.stringify({ ok: true, dryRun: true, offerId }), { status: 200 });
    }

    const result = await insertProduct({
      offerId,
      title: product.name,
      description: product.description ?? '',
      link,
      imageLink,
      price: { value: String((priceValue / 100).toFixed(2)), currency },
      availability: 'in stock',
      condition: 'new',
      brand: defaultBrand,
      contentLanguage: process.env.CONTENT_LANGUAGE || 'vi',
      targetCountry: process.env.TARGET_COUNTRY || 'VN',
      channel: 'online',
      additionalImageLinks,
      mpn,
      googleProductCategory,
    });

    if (!result.ok) {
      await reporter.notify('❌ Đồng bộ GMC thất bại', `<pre>${escapeHtml(result.error ?? 'Unknown error')}</pre>`);
      return new Response(JSON.stringify({ ok: false, error: result.error ?? 'GMC error' }), { status: 500 });
    }

    await reporter.notify('✅ Đồng bộ GMC thành công', `OfferId: <code>${escapeHtml(offerId)}</code>`);
    return new Response(JSON.stringify({ ok: true, id: result.id, offerId }), { status: 200 });
  } catch (error) {
    await reporter.notify('❌ Lỗi xử lý webhook GMC', `<pre>${escapeHtml(error instanceof Error ? error.message : String(error))}</pre>`);
    return new Response(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }), { status: 500 });
  }
}