import type { VercelRequest, VercelResponse } from '@vercel/node';

const SHOP_API = process.env.VENDURE_SHOP_API || process.env.NEXT_PUBLIC_SHOP_API || 'http://localhost:3000/shop-api';

async function vendureFetch<T = any>(query: string, variables: Record<string, any> = {}): Promise<T> {
  const res = await fetch(SHOP_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`Vendure fetch failed: ${res.status} ${res.statusText}`);
  }
  const json = await res.json();
  if (json.errors) {
    const msg = json.errors[0]?.message || 'Unknown GraphQL error';
    throw new Error(`Vendure GraphQL error: ${msg}`);
  }
  return json.data as T;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  try {
    const { productSlug, productVariantId, quantity = 1 } = req.body || {};
    if (!productSlug || !productVariantId) {
      res.status(400).json({ ok: false, error: 'Missing productSlug or productVariantId' });
      return;
    }

    const productQ = `
      query P($slug: String!) {
        product(slug: $slug) {
          id
          slug
          name
          variants {
            id
            name
            priceWithTax
            stockLevel
          }
        }
      }
    `;

    const data = await vendureFetch<{ product: any }>(productQ, { slug: productSlug });
    const product = data?.product;
    if (!product) {
      res.status(404).json({ ok: false, error: 'Product not found' });
      return;
    }

    const variant = Array.isArray(product.variants)
      ? product.variants.find((v: any) => String(v.id) === String(productVariantId))
      : null;
    if (!variant) {
      res.status(400).json({ ok: false, error: 'Variant not found on product' });
      return;
    }

    if (variant.stockLevel === 'OUT_OF_STOCK') {
      res.status(409).json({ ok: false, error: 'Variant out of stock' });
      return;
    }

    if (Number(quantity) <= 0) {
      res.status(400).json({ ok: false, error: 'Quantity must be >= 1' });
      return;
    }

    res.status(200).json({ ok: true, variant: { id: variant.id, name: variant.name, price: (variant.priceWithTax ?? 0) / 100 } });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || 'Internal Server Error' });
  }
}