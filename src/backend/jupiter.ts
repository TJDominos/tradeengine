import { ApiError } from './errors';

const SOLANA_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const JUPITER_SWAP_API_BASE_URL = 'https://lite-api.jup.ag/swap/v1';

export interface JupiterTokenMetadata {
  address: string;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  logoUri: string | null;
  tags: string[];
  fdv: number | null;
  liquidityUsd: number | null;
  totalHolders: number | null;
  usdPrice: number | null;
  volume24h: number | null;
  totalTransactions24h: number | null;
  dexId: string | null;
  pairAddress: string | null;
}

export type JupiterQuoteResponse = {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: unknown[];
  contextSlot?: number;
};

export interface JupiterSwapRequestPayload {
  quoteResponse: JupiterQuoteResponse;
  userPublicKey: string;
  wrapAndUnwrapSol: boolean;
  dynamicComputeUnitLimit: boolean;
}

export interface JupiterSwapTransactionBuildTrace {
  requestPayload: JupiterSwapRequestPayload;
  swapTransactionBase64: string;
  swapTransactionBytes: Uint8Array;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

export async function fetchJupiterTokenMetadata(
  mint: string,
): Promise<JupiterTokenMetadata | null> {
  try {
    console.log(`[fetchJupiterTokenMetadata] Searching for token: ${mint}`);
    const searchResponse = await fetch(
      `https://lite-api.jup.ag/tokens/v2/search?query=${encodeURIComponent(mint)}`,
      { headers: { Accept: 'application/json' } },
    );
    console.log(`[fetchJupiterTokenMetadata] Search API response status: ${searchResponse.status}`);

    if (searchResponse.ok) {
      const tokensArray = await searchResponse.json<any[]>();
      console.log(`[fetchJupiterTokenMetadata] Search API returned array with ${tokensArray?.length ?? 0} items`);

      if (Array.isArray(tokensArray) && tokensArray.length > 0) {
        const tokenData = tokensArray[0];
        const assetData = tokenData.asset || {};
        console.log(`[fetchJupiterTokenMetadata] First token: ${tokenData.symbol || tokenData.name}, asset keys: ${Object.keys(assetData).join(', ')}`);

        const stats24h = tokenData.stats24h && typeof tokenData.stats24h === 'object'
          ? tokenData.stats24h
          : assetData.stats24h && typeof assetData.stats24h === 'object'
            ? assetData.stats24h
            : {};

        const fdv =
          toFiniteNumber(tokenData.fdv) ??
          toFiniteNumber(assetData.fdv) ??
          toFiniteNumber(tokenData.mcap) ??
          toFiniteNumber(assetData.mcap);

        const liquidityUsd =
          toFiniteNumber(tokenData.liquidity) ??
          toFiniteNumber(tokenData.liquidity?.usd) ??
          toFiniteNumber(assetData.liquidity) ??
          toFiniteNumber(assetData.liquidity?.usd);

        const totalHolders =
          toFiniteNumber(tokenData.holderCount) ??
          toFiniteNumber(tokenData.holder) ??
          toFiniteNumber(tokenData.holders) ??
          toFiniteNumber(assetData.holderCount) ??
          toFiniteNumber(assetData.holder) ??
          toFiniteNumber(assetData.holders);

        const usdPrice =
          toFiniteNumber(tokenData.usdPrice) ??
          toFiniteNumber(tokenData.price) ??
          toFiniteNumber(assetData.usdPrice) ??
          toFiniteNumber(assetData.price);

        const buyVolume24h =
          toFiniteNumber(stats24h.buyVolume) ??
          toFiniteNumber(stats24h.buy_volume);
        const sellVolume24h =
          toFiniteNumber(stats24h.sellVolume) ??
          toFiniteNumber(stats24h.sell_volume);
        const volume24h =
          buyVolume24h != null || sellVolume24h != null
            ? (buyVolume24h ?? 0) + (sellVolume24h ?? 0)
            : null;

        const directTransactions24h =
          toFiniteNumber(stats24h.numTransactions) ??
          toFiniteNumber(stats24h.transactions);
        const totalTransactions24hRaw =
          (toFiniteNumber(stats24h.numBuys) ?? toFiniteNumber(stats24h.buys) ?? 0) +
          (toFiniteNumber(stats24h.numSells) ?? toFiniteNumber(stats24h.sells) ?? 0);
        const totalTransactions24h = directTransactions24h != null
          ? Math.trunc(directTransactions24h)
          : totalTransactions24hRaw > 0
            ? Math.trunc(totalTransactions24hRaw)
            : null;

        const dexId =
          readNonEmptyString(tokenData.dexId) ??
          readNonEmptyString(tokenData.launchpad) ??
          readNonEmptyString(tokenData.metaLaunchpad) ??
          null;
        const pairAddress =
          readNonEmptyString(tokenData.firstPool?.id) ??
          readNonEmptyString(tokenData.graduatedPool) ??
          null;

        console.log(
          `[fetchJupiterTokenMetadata] Extracted: price=${usdPrice}, fdv=${fdv}, holders=${totalHolders}, liquidity=${liquidityUsd}, volume24h=${volume24h}, tx24h=${totalTransactions24h}`,
        );

        return {
          address: tokenData.address || tokenData.mint || mint,
          name: typeof tokenData.name === 'string' ? tokenData.name : null,
          symbol: typeof tokenData.symbol === 'string' ? tokenData.symbol : null,
          decimals: typeof tokenData.decimals === 'number' ? tokenData.decimals : null,
          logoUri: typeof tokenData.logoURI === 'string'
            ? tokenData.logoURI
            : typeof tokenData.icon === 'string'
              ? tokenData.icon
              : null,
          tags: Array.isArray(tokenData.tags) ? tokenData.tags : [],
          fdv,
          liquidityUsd,
          totalHolders,
          usdPrice,
          volume24h,
          totalTransactions24h,
          dexId,
          pairAddress,
        };
      }
    } else {
      console.log(`[fetchJupiterTokenMetadata] Search API error: ${searchResponse.status}`);
    }

    console.log('[fetchJupiterTokenMetadata] Trying tokens.jup.ag fallback endpoint');
    const fallbackResponse = await fetch(
      `https://tokens.jup.ag/token/${encodeURIComponent(mint)}`,
      { headers: { Accept: 'application/json' } },
    );
    console.log(`[fetchJupiterTokenMetadata] Fallback endpoint response status: ${fallbackResponse.status}`);

    if (fallbackResponse.ok) {
      const fallback = await fallbackResponse.json<any>();
      console.log(`[fetchJupiterTokenMetadata] Found token in fallback: ${fallback.symbol || fallback.name}`);
      return {
        address: fallback.address ?? mint,
        name: typeof fallback.name === 'string' ? fallback.name : null,
        symbol: typeof fallback.symbol === 'string' ? fallback.symbol : null,
        decimals: typeof fallback.decimals === 'number' ? fallback.decimals : null,
        logoUri: typeof fallback.logoURI === 'string' ? fallback.logoURI : null,
        tags: Array.isArray(fallback.tags) ? fallback.tags : [],
        fdv: null,
        liquidityUsd: null,
        totalHolders: null,
        usdPrice: null,
        volume24h: null,
        totalTransactions24h: null,
        dexId: null,
        pairAddress: null,
      };
    }

    console.log(`[fetchJupiterTokenMetadata] Fallback endpoint error: ${fallbackResponse.status}`);
    console.log('[fetchJupiterTokenMetadata] Both APIs failed, returning null');
    return null;
  } catch (err: unknown) {
    console.error('[fetchJupiterTokenMetadata] Exception:', err);
    return null;
  }
}

export async function fetchJupiterTokenPrice(mint: string): Promise<number | null> {
  try {
    const response = await fetch(
      `https://api.jup.ag/price/v2?ids=${encodeURIComponent(mint)}`,
      { headers: { Accept: 'application/json' } },
    );
    if (!response.ok) return null;
    const body = await response.json<{
      data?: Record<string, { price?: number | string } | null>;
    }>();
    const entry = body.data?.[mint] ?? body.data?.[mint.toLowerCase()];
    if (!entry) return null;
    const price = toFiniteNumber(entry.price);
    return price != null && price > 0 ? price : null;
  } catch {
    return null;
  }
}

export async function fetchJupiterPriceViaQuote(
  mint: string,
  tokenDecimals: number,
): Promise<number | null> {
  try {
    const url = new URL(`${JUPITER_SWAP_API_BASE_URL}/quote`);
    url.searchParams.set('inputMint', SOLANA_USDC_MINT);
    url.searchParams.set('outputMint', mint);
    url.searchParams.set('amount', '1000000');
    url.searchParams.set('slippageBps', '500');

    const response = await fetch(url.toString(), {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return null;

    const body = await response.json<{
      outAmount?: string;
      error?: string;
    }>();
    if (body.error || !body.outAmount) return null;

    const outAmount = Number(body.outAmount);
    if (!Number.isFinite(outAmount) || outAmount <= 0) return null;
    return (10 ** tokenDecimals) / outAmount;
  } catch {
    return null;
  }
}

export async function fetchJupiterSwapQuote(
  inputMint: string,
  outputMint: string,
  amountAtomicUnits: string,
  slippageBps: number,
): Promise<JupiterQuoteResponse> {
  const url = new URL(`${JUPITER_SWAP_API_BASE_URL}/quote`);
  url.searchParams.set('inputMint', inputMint);
  url.searchParams.set('outputMint', outputMint);
  url.searchParams.set('amount', amountAtomicUnits);
  url.searchParams.set('slippageBps', String(slippageBps));

  const response = await fetch(url.toString(), {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new ApiError(502, `Jupiter quote request failed (${response.status}): ${errText.slice(0, 200)}`);
  }
  const body = await response.json<JupiterQuoteResponse & { error?: string }>();
  if (body.error) {
    throw new ApiError(502, `Jupiter quote error: ${body.error}`);
  }
  return body;
}

export async function buildJupiterSwapTransactionWithTrace(
  quoteResponse: JupiterQuoteResponse,
  userPublicKey: string,
): Promise<JupiterSwapTransactionBuildTrace> {
  const requestPayload: JupiterSwapRequestPayload = {
    quoteResponse,
    userPublicKey,
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
  };
  const response = await fetch(`${JUPITER_SWAP_API_BASE_URL}/swap`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(requestPayload),
  });
  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new ApiError(502, `Jupiter swap transaction request failed (${response.status}): ${errText.slice(0, 200)}`);
  }
  const body = await response.json<{ swapTransaction?: string; error?: string }>();
  if (body.error) {
    throw new ApiError(502, `Jupiter swap error: ${body.error}`);
  }
  if (!body.swapTransaction) {
    throw new ApiError(502, 'Jupiter swap response missing transaction');
  }
  return {
    requestPayload,
    swapTransactionBase64: body.swapTransaction,
    swapTransactionBytes: Uint8Array.from(
      atob(body.swapTransaction),
      (c) => c.charCodeAt(0),
    ),
  };
}

export async function buildJupiterSwapTransaction(
  quoteResponse: JupiterQuoteResponse,
  userPublicKey: string,
): Promise<Uint8Array> {
  const trace = await buildJupiterSwapTransactionWithTrace(
    quoteResponse,
    userPublicKey,
  );
  return trace.swapTransactionBytes;
}