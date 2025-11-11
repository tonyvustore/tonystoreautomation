interface OAuthTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

export interface GmcProduct {
  offerId: string;
  title: string;
  description: string;
  link: string;
  imageLink: string;
  price: { value: string; currency: string };
  availability: 'in stock' | 'out of stock' | 'preorder';
  condition: 'new' | 'refurbished' | 'used';
  brand?: string;
  contentLanguage?: string; // e.g., 'vi'
  targetCountry?: string; // e.g., 'VN'
  channel?: 'online';
  additionalImageLinks?: string[];
  mpn?: string;
  gtin?: string;
  googleProductCategory?: string;
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing env: ${key}`);
  return value;
}

async function getAccessToken(): Promise<string> {
  const clientId = requireEnv('GOOGLE_CLIENT_ID');
  const clientSecret = requireEnv('GOOGLE_CLIENT_SECRET');
  const refreshToken = requireEnv('GOOGLE_REFRESH_TOKEN');

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }).toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OAuth token error ${res.status}: ${text}`);
  }
  const json = (await res.json()) as OAuthTokenResponse;
  return json.access_token;
}

export async function insertProduct(product: GmcProduct): Promise<{ ok: boolean; id?: string; error?: string }> {
  const merchantId = requireEnv('GMC_MERCHANT_ID');
  const accessToken = await getAccessToken();

  const body = {
    offerId: product.offerId,
    title: product.title,
    description: product.description,
    link: product.link,
    imageLink: product.imageLink,
    contentLanguage: product.contentLanguage ?? process.env.CONTENT_LANGUAGE ?? 'vi',
    targetCountry: product.targetCountry ?? process.env.TARGET_COUNTRY ?? 'VN',
    channel: product.channel ?? 'online',
    availability: product.availability,
    condition: product.condition,
    brand: product.brand,
    price: product.price,
    additionalImageLinks: product.additionalImageLinks,
    mpn: product.mpn,
    gtin: product.gtin,
    googleProductCategory: product.googleProductCategory,
  };

  const url = `https://shoppingcontent.googleapis.com/content/v2.1/${encodeURIComponent(merchantId)}/products`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    return { ok: false, error: text };
  }
  const data = await res.json();
  return { ok: true, id: data?.id ?? product.offerId };
}