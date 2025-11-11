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

function parseListParam(input: unknown): string[] {
  if (!input) return [];
  const s = Array.isArray(input) ? input.join(',') : String(input);
  return s
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

function parseWeightsParam(input: unknown): Record<string, number> {
  const defaults: Record<string, number> = { Collection: 1.2, Style: 1, Color: 0.3, UpsellRank: 1, PriceDelta: 1.5 };
  if (!input) return defaults;
  const s = Array.isArray(input) ? input.join(',') : String(input);
  const out: Record<string, number> = { ...defaults };
  s
    .split(',')
    .map((pair) => pair.trim())
    .filter(Boolean)
    .forEach((pair) => {
      const [code, weightStr] = pair.split(':').map((x) => x.trim());
      const w = Number(weightStr);
      if (code && Number.isFinite(w)) out[code] = w;
    });
  return out;
}

function toFacetMap(facetValues: any[]): Record<string, Set<string>> {
  const map: Record<string, Set<string>> = {};
  for (const fv of facetValues || []) {
    const code = fv?.facet?.code || fv?.code;
    const id = fv?.id;
    if (!code || !id) continue;
    if (!map[code]) map[code] = new Set<string>();
    map[code].add(String(id));
  }
  return map;
}

function parseNumeric(value: string): number {
  const m = String(value || '').match(/[-+]?[0-9]*\.?[0-9]+/);
  return m ? Number(m[0]) : 0;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  try {
    const slug = (req.query.slug as string) || '';
    if (!slug) {
      res.status(400).json({ error: 'Missing slug query param' });
      return;
    }

    const take = Number(req.query.take || req.query.limit || 8);
    const sort = String(req.query.sort || 'score').toLowerCase(); // default score
    const includeFacets = parseListParam(req.query.includeFacets);
    const excludeProductTypeParam = (req.query.excludeProductType as string) || '';
    const weights = parseWeightsParam(req.query.weights);
    const minPriceFactor = Number(req.query.minPriceFactor || 1.2);

    const defaultFacetCodes = ['Collection', 'Style'];
    const facetCodes = includeFacets.length ? includeFacets : defaultFacetCodes;

    const productQ = `
      query P($slug: String!) {
        product(slug: $slug) {
          id
          slug
          name
          featuredAsset { preview }
          collections { id name }
          facetValues { id name code facet { id code } }
          variants { id priceWithTax }
        }
      }
    `;

    const prodData = await vendureFetch<{ product: any }>(productQ, { slug });
    const product = prodData?.product;
    if (!product) {
      res.status(404).json({ error: 'Product not found' });
      return;
    }

    const currentFacetMap = toFacetMap(product.facetValues || []);
    const currentProductType = ((product.facetValues || []) as any[])
      .find((fv: any) => fv?.facet?.code === 'ProductType')?.name || '';

    const excludeProductType = excludeProductTypeParam || '';

    const collectionIds: string[] = Array.isArray(product.collections) ? product.collections.map((c: any) => c.id) : [];
    const facetValueIds: string[] = Array.isArray(product.facetValues)
      ? product.facetValues
          .filter((fv: any) => fv?.facet?.code && facetCodes.includes(String(fv.facet.code)))
          .map((fv: any) => fv.id)
      : [];

    const basePrices: number[] = Array.isArray(product.variants)
      ? product.variants.map((v: any) => Number(v?.priceWithTax ?? 0)).filter((p: number) => Number.isFinite(p))
      : [];
    const baseMinPrice = basePrices.length ? Math.min(...basePrices) : 0;

    const searchQ = `
      query S($facetValueIds: [ID!], $collectionIds: [ID!], $take: Int!) {
        search(input: {
          groupByProduct: true,
          take: $take,
          facetValueIds: $facetValueIds,
          filter: { collectionId: { in: $collectionIds } }
        }) {
          items {
            productId
            slug
            productName
            priceWithTax
            preview
          }
        }
      }
    `;

    const vars: Record<string, any> = {
      facetValueIds: facetValueIds.length ? facetValueIds : null,
      collectionIds: !facetValueIds.length && collectionIds.length ? collectionIds : null,
      take: take + 12,
    };

    const searchData = await vendureFetch<{ search: { items: any[] } }>(searchQ, vars);
    let items: any[] = Array.isArray(searchData?.search?.items) ? searchData.search.items : [];

    // exclude current product
    items = items.filter((it) => String(it.productId) !== String(product.id));

    // scoring for upsell
    const candidateQ = `
      query C($id: ID!) {
        product(id: $id) {
          id
          slug
          name
          assets { preview }
          facetValues { id name code facet { code } }
        }
      }
    `;

    const sampleSize = Math.min(items.length, Math.max(take + 8, 16));
    const pool = items.slice(0, sampleSize);

    const details = await Promise.all(
      pool.map(async (it) => {
        try {
          const data = await vendureFetch<{ product: any }>(candidateQ, { id: it.productId });
          return { it, cand: data?.product };
        } catch {
          return { it, cand: null };
        }
      })
    );

    const scored = details
      .map(({ it, cand }) => {
        if (!cand) return null;
        const candFacetMap = toFacetMap(cand.facetValues || []);
        const candProductType = (cand.facetValues || []).find((fv: any) => fv?.facet?.code === 'ProductType')?.name || '';
        if (excludeProductType && candProductType && candProductType === excludeProductType) return null;

        let score = 0;
        // facet match scoring
        for (const code of Object.keys(weights)) {
          if (code === 'UpsellRank' || code === 'PriceDelta') continue;
          const currentIds = currentFacetMap[code];
          const candIds = candFacetMap[code];
          if (currentIds && candIds) {
            const overlap = [...currentIds].some((id) => candIds.has(id));
            if (overlap) score += weights[code] || 0;
          }
        }

        // UpsellRank boost
        const rankFv = (cand.facetValues || []).find((fv: any) => fv?.facet?.code === 'UpsellRank');
        if (rankFv && weights['UpsellRank']) {
          score += (weights['UpsellRank'] || 0) * parseNumeric(String(rankFv.name || ''));
        }

        // PriceDelta boost
        if (baseMinPrice > 0 && weights['PriceDelta']) {
          const price = Number(it.priceWithTax ?? 0);
          const factor = price / baseMinPrice;
          if (minPriceFactor > 0 && factor < minPriceFactor) {
            return null;
          }
          if (factor > 1) {
            score += (weights['PriceDelta'] || 0) * (factor - 1);
          }
        }

        return {
          productId: it.productId,
          slug: it.slug,
          name: it.productName,
          priceWithTax: it.priceWithTax ?? 0,
          image: it.preview || cand.assets?.[0]?.preview || product.featuredAsset?.preview || null,
          score,
        };
      })
      .filter(Boolean) as Array<{
        productId: string;
        slug: string;
        name: string;
        priceWithTax: number;
        image: string | null;
        score: number;
      }>;

    scored.sort((a, b) => b.score - a.score || Number(a.priceWithTax) - Number(b.priceWithTax));
    const limitedItems = scored.slice(0, take);

    const upsells = limitedItems.map((it: any) => ({
      productId: it.productId,
      slug: it.slug,
      name: it.name ?? it.productName,
      price: Number((it.priceWithTax ?? 0)) / 100,
      image: it.image || it.preview || product.featuredAsset?.preview || null,
      score: typeof it.score === 'number' ? it.score : undefined,
    }));

    res.status(200).json({
      source: facetValueIds.length ? 'facets-search' : 'collections-search',
      product: { id: product.id, slug: product.slug, productType: currentProductType || undefined, baseMinPrice: baseMinPrice || undefined },
      upsells,
      params: { take, sort: 'score', facetCodes, excludeProductType: excludeProductType || undefined, weights, minPriceFactor },
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'Internal Server Error' });
  }
}