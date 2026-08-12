import { ApiError } from '../errors';
import { summarizeStrategyRuntime } from '../strategy/runtime';
import type { ExternalTradeEvent } from '../strategy/triggers';
import { type StrategyEngineDurableObjectEventRequest } from '../strategy/strategyEngineDO';
import { buildWebhookStrategyTrigger } from '../strategy/triggers';
import { nowTs } from '../time';
import {
  dbFindTradableTokenById,
  dbResolveSolanaRpcUrls,
  dbResolveTradableTokenId,
} from '../tokenStore';
import { dbAddAuditLog, dbLoadSettings } from '../userStore';
import type {
  AlchemyWebhookPayload,
  DerivedChainSignal,
  Env,
  SignalRecord,
  TokenMarketSnapshot,
} from '../workerShared';
import { SOLANA_USDC_MINT } from '../workerShared';
import {
  extractWebhookTransactionDetailsFromPayload,
  isRecord,
  jsonResponse,
  mergeStoredSignalTransactionDetails,
  normalizePubkey,
  readNonEmptyString,
  tryNormalizeSolanaPubkey,
  uniqueSolanaPubkeys,
} from '../workerCore';
import { parseJsonText } from '../workerSchema';
import {
  applyAmmPoolDirectionCorrection,
  dbApplyTokenHolderTransactionDelta,
  dbClaimSignalProcessing,
  dbCreateSignal,
  dbFindSignalByUserTxSignature,
  dbMarkSignalFailed,
  dbMarkSignalProcessed,
  dbResolvePreferredSignalWalletAddress,
  dbUpsertWebhookTransactionLog,
  dbUpdateSignalTransactionDetails,
  fetchSolanaWebhookTransactionDetailsFromRpc,
} from '../services/signalStore';
import { StrategyAutomationService } from '../services/strategyAutomationService';
import { getActiveStrategy, runAndPersistStrategyEvaluation } from '../services/strategyStore';
import { syncTokenMarketSnapshotForUser } from '../services/tokenMarketService';

const strategyAutomationService = new StrategyAutomationService();

async function resolveSignalStorageTarget(
  env: Env,
  input: {
    userId: number;
    source: string;
    externalId: string;
    eventType: string;
    walletAddress: string | null;
    txSignature: string | null;
    payload: string;
    detailsJson?: string | null;
  },
): Promise<{
  signal: SignalRecord;
  inserted: boolean;
  reusedByTxSignature: boolean;
}> {
  const existingByTxSignature = input.txSignature
    ? await dbFindSignalByUserTxSignature(
        env.TRADINGBOT_DB,
        input.userId,
        input.txSignature,
      )
    : null;

  if (
    existingByTxSignature &&
    (
      existingByTxSignature.source !== input.source ||
      existingByTxSignature.externalId !== input.externalId
    )
  ) {
    return {
      signal: existingByTxSignature,
      inserted: false,
      reusedByTxSignature: true,
    };
  }

  const created = await dbCreateSignal(env.TRADINGBOT_DB, {
    source: input.source,
    externalId: input.externalId,
    eventType: input.eventType,
    walletAddress: input.walletAddress,
    txSignature: input.txSignature,
    payload: input.payload,
    detailsJson: input.detailsJson ?? null,
  });

  return {
    signal: created.signal,
    inserted: created.inserted,
    reusedByTxSignature: false,
  };
}

export async function handleWebhookRoutes(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (
    request.method === 'POST' &&
    (url.pathname === '/api/webhook' || url.pathname === '/api/webhooks/strategy/external-trade')
  ) {
    return handleRustNodeWebhook(request, env);
  }
  if (request.method === 'POST' && url.pathname === '/api/webhooks/alchemy/notify') {
    return handleAlchemyNotifyWebhook(request, url, env, ctx);
  }
  return null;
}

function parseRustNodeWebhookPayload(body: unknown): ExternalTradeEvent {
  if (!isRecord(body)) {
    throw new ApiError(400, 'Webhook body must be a JSON object');
  }

  const eventType = readNonEmptyString(body.type);
  if (eventType !== 'whale_buy' && eventType !== 'whale_sell') {
    throw new ApiError(400, 'Webhook type must be whale_buy or whale_sell');
  }

  const amount = typeof body.amount === 'number' ? body.amount : Number.NaN;
  if (!Number.isFinite(amount) || amount < 0) {
    throw new ApiError(400, 'Webhook amount must be a finite non-negative number');
  }

  const walletAddressRaw =
    readNonEmptyString(body.wallet_address) ??
    readNonEmptyString(body.walletAddress);
  if (!walletAddressRaw) {
    throw new ApiError(400, 'Webhook wallet_address is required');
  }

  const contractAddress =
    tryNormalizeSolanaPubkey(body.contract_address) ??
    tryNormalizeSolanaPubkey(body.contractAddress);
  if (!contractAddress) {
    throw new ApiError(400, 'Webhook contractAddress is required');
  }

  const txHash =
    readNonEmptyString(body.txHash) ??
    readNonEmptyString(body.tx_hash) ??
    readNonEmptyString(body.signature) ??
    readNonEmptyString(body.txSignature);
  if (!txHash) {
    throw new ApiError(400, 'Webhook txHash is required for deduplication');
  }

  const isLossCutValue =
    typeof body.is_loss_cut === 'boolean'
      ? body.is_loss_cut
      : typeof body.isLossCut === 'boolean'
        ? body.isLossCut
        : false;

  return {
    type: eventType,
    amount,
    contractAddress,
    txHash,
    wallet_address: normalizePubkey(walletAddressRaw),
    is_loss_cut: isLossCutValue,
    payloadJson: JSON.stringify(body),
  };
}

async function handleRustNodeWebhook(
  request: Request,
  env: Env,
): Promise<Response> {
  const payload = parseRustNodeWebhookPayload(await parseJsonText<unknown>(await request.text()));
  const activeTarget = await strategyAutomationService.getActiveStrategyStub(env);
  if (!activeTarget) {
    return jsonResponse({ ok: true, ignored: true, reason: 'no_active_strategy' }, 200);
  }

  if (activeTarget.record.config.strategyVersionId == null) {
    throw new ApiError(500, 'Active strategy is missing strategyVersionId');
  }

  const doRequest: StrategyEngineDurableObjectEventRequest = {
    userId: activeTarget.record.config.userId,
    versionId: activeTarget.record.config.strategyVersionId,
    strategyDocument: activeTarget.record.config.document,
    event: payload,
  };
  const response = await activeTarget.stub.fetch('https://strategy-engine/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(doRequest),
  });
  if (!response.ok) {
    const message = await response.text();
    throw new ApiError(response.status, message || 'Failed to forward webhook to strategy engine');
  }

  const forwarded = await response.json<{
    duplicate?: boolean;
    status?: string;
    metrics?: Record<string, unknown>;
  }>();

  const signalSource = `strategy_webhook:user:${activeTarget.record.config.userId}`;
  const signalExternalId = `${signalSource}:${payload.txHash}`;
  const initialAction: 'BUY' | 'SELL' = payload.type === 'whale_sell' ? 'SELL' : 'BUY';
  const initialDetails = {
    tokenContractAddress: payload.contractAddress,
    primaryWalletAddress: payload.wallet_address,
    action: initialAction,
    source: 'webhook' as const,
    transactionStatus: 'PENDING' as const,
    detailSource: 'payload' as const,
  };

  const signalTarget = await resolveSignalStorageTarget(env, {
    userId: activeTarget.record.config.userId,
    source: signalSource,
    externalId: signalExternalId,
    eventType: payload.type,
    walletAddress: payload.wallet_address,
    txSignature: payload.txHash,
    payload: payload.payloadJson ?? JSON.stringify(payload),
    detailsJson: JSON.stringify(initialDetails),
  });
  const targetSource = signalTarget.signal.source;
  const targetExternalId = signalTarget.signal.externalId;

  if (
    signalTarget.inserted ||
    signalTarget.reusedByTxSignature ||
    !signalTarget.signal.processed
  ) {
    const claimed = signalTarget.inserted || signalTarget.signal.processed
      ? true
      : await dbClaimSignalProcessing(
          env.TRADINGBOT_DB,
          targetSource,
          targetExternalId,
        );

    if (claimed) {
      let latestDetails = mergeStoredSignalTransactionDetails(initialDetails);
      let latestWalletAddress = payload.wallet_address;
      let latestChainTimeMs: number | null = null;
      try {
        const rpcUrls = await dbResolveSolanaRpcUrls(
          env.TRADINGBOT_DB,
          activeTarget.record.config.userId,
          env.SOLANA_RPC_URL,
        );
        const tokenId = await dbResolveTradableTokenId(
          env.TRADINGBOT_DB,
          payload.contractAddress,
        );
        const payloadDetails = extractWebhookTransactionDetailsFromPayload(
          payload.payloadJson ?? JSON.stringify(payload),
          payload.contractAddress,
        );
        const rpcResult = payload.txHash
          ? await fetchSolanaWebhookTransactionDetailsFromRpc(
              rpcUrls,
              payload.txHash,
              payload.contractAddress,
              payloadDetails,
            )
          : null;
        latestChainTimeMs = rpcResult?.chainTimeMs ?? null;
        const mergedDetails = mergeStoredSignalTransactionDetails(
          initialDetails,
          payloadDetails,
          rpcResult?.details,
        );
        const preferredWalletAddress = await dbResolvePreferredSignalWalletAddress(
          env.TRADINGBOT_DB,
          activeTarget.record.config.userId,
          [
            mergedDetails.primaryWalletAddress,
            mergedDetails.fromWalletAddress,
            mergedDetails.toWalletAddress,
          ],
          payload.wallet_address,
        );
        mergedDetails.primaryWalletAddress = preferredWalletAddress;
        latestDetails = mergedDetails;
        latestWalletAddress = preferredWalletAddress ?? payload.wallet_address;
        await dbUpdateSignalTransactionDetails(
          env.TRADINGBOT_DB,
          targetSource,
          targetExternalId,
          preferredWalletAddress,
          mergedDetails,
        );
        if (tokenId && payload.txHash) {
          await dbApplyTokenHolderTransactionDelta(
            env.TRADINGBOT_DB,
            activeTarget.record.config.userId,
            tokenId,
            payload.txHash,
            mergedDetails,
          ).catch((err) => {
            console.warn(`Failed to apply token holder delta for ${payload.txHash}:`, err);
          });
        }
        await dbMarkSignalProcessed(
          env.TRADINGBOT_DB,
          targetSource,
          targetExternalId,
        );
        await dbUpsertWebhookTransactionLog(env.TRADINGBOT_DB, {
          userId: activeTarget.record.config.userId,
          tokenId,
          tokenContractAddress: payload.contractAddress,
          source: mergedDetails.source,
          eventType: payload.type,
          txSignature: payload.txHash,
          externalId: signalExternalId,
          walletAddress: latestWalletAddress,
          details: latestDetails,
          processed: true,
          errorMessage: null,
          chainTimeMs: latestChainTimeMs,
          createdAt: signalTarget.signal.createdAt,
          metadata: {
            updateReason: 'strategy_webhook_process',
            signalSource,
            signalExternalId,
            chainTimeMs: latestChainTimeMs,
          },
        });
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        await dbMarkSignalFailed(
          env.TRADINGBOT_DB,
          targetSource,
          targetExternalId,
          errorMessage,
        );
        await dbUpsertWebhookTransactionLog(env.TRADINGBOT_DB, {
          userId: activeTarget.record.config.userId,
          tokenId: null,
          tokenContractAddress: payload.contractAddress,
          source: latestDetails.source,
          eventType: payload.type,
          txSignature: payload.txHash,
          externalId: signalExternalId,
          walletAddress: latestWalletAddress,
          details: latestDetails,
          processed: false,
          errorMessage,
          chainTimeMs: latestChainTimeMs,
          createdAt: signalTarget.signal.createdAt,
          metadata: {
            updateReason: 'strategy_webhook_failed',
            signalSource,
            signalExternalId,
            chainTimeMs: latestChainTimeMs,
          },
        });
      }
    }
  }

  return jsonResponse({
    ok: true,
    forwarded: true,
    duplicate: forwarded.duplicate ?? false,
    status: forwarded.status ?? 'running',
  }, 200);
}

async function dbListUserIdsByActiveContractAddress(
  db: D1Database,
  contractAddress: string,
  quoteTokenAddress?: string,
): Promise<number[]> {
  const normalizedContractAddress = normalizePubkey(contractAddress);
  const normalizedQuoteTokenAddress =
    typeof quoteTokenAddress === 'string' && quoteTokenAddress.trim().length > 0
      ? normalizePubkey(quoteTokenAddress)
      : null;
  const rows = await db
    .prepare(
      `SELECT DISTINCT s_base.user_id
       FROM settings s_base
       LEFT JOIN settings s_quote
         ON s_quote.user_id = s_base.user_id
        AND s_quote.key = 'activeQuoteTokenAddress'
       WHERE s_base.key IN ('activeBaseTokenAddress', 'contractAddress')
         AND s_base.value = ?1
         AND (?2 IS NULL OR COALESCE(NULLIF(s_quote.value, ''), ?3) = ?2)
       ORDER BY s_base.user_id ASC`,
    )
    .bind(normalizedContractAddress, normalizedQuoteTokenAddress, SOLANA_USDC_MINT)
    .all<{ user_id: number }>();
  return rows.results.map((row) => row.user_id);
}

function resolveAlchemyWebhookSigningKey(env: Env): string {
  const signingKey =
    env.ALCHEMY_WEBHOOK_SIGNING_KEY?.trim() ||
    env.ALCHEMY_WEBHOOK_SECRET?.trim();
  if (!signingKey) {
    throw new ApiError(
      503,
      'ALCHEMY_WEBHOOK_SIGNING_KEY is not configured',
    );
  }
  return signingKey;
}

function parseHexString(value: string): Uint8Array {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized.length % 2 !== 0 || /[^0-9a-f]/.test(normalized)) {
    throw new ApiError(400, 'X-Alchemy-Signature must be a valid hex string');
  }
  const bytes = new Uint8Array(normalized.length / 2);
  for (let index = 0; index < normalized.length; index += 2) {
    bytes[index / 2] = Number.parseInt(normalized.slice(index, index + 2), 16);
  }
  return bytes;
}

async function assertAlchemyWebhookSignature(
  request: Request,
  env: Env,
  rawBody: string,
): Promise<void> {
  const signature = request.headers.get('X-Alchemy-Signature')?.trim();
  if (!signature) {
    throw new ApiError(401, 'Missing X-Alchemy-Signature header');
  }

  const signingKey = resolveAlchemyWebhookSigningKey(env);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(signingKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const isValid = await crypto.subtle.verify(
    'HMAC',
    key,
    parseHexString(signature),
    new TextEncoder().encode(rawBody),
  );
  if (!isValid) {
    throw new ApiError(401, 'Alchemy webhook signature is invalid');
  }
}

function compactDefinedRecord(
  entries: Array<[string, unknown]>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    if (value == null) {
      continue;
    }
    if (Array.isArray(value) && value.length === 0) {
      continue;
    }
    if (isRecord(value) && Object.keys(value).length === 0) {
      continue;
    }
    result[key] = value;
  }
  return result;
}

function compactAddressParticipant(value: unknown): Record<string, unknown> | null {
  const record = isRecord(value) ? value : null;
  const address = readNonEmptyString(record?.address);
  return address ? { address } : null;
}

function extractTokenTransferContractAddresses(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return uniqueSolanaPubkeys(
    value.flatMap((item) => {
      if (!isRecord(item)) {
        return [];
      }
      return [item.mint, item.tokenAddress, item.contractAddress];
    }),
  );
}

function buildCompactAlchemyLogPayload(
  logValue: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!logValue) {
    return null;
  }
  const transaction = isRecord(logValue.transaction) ? logValue.transaction : null;
  return compactDefinedRecord([
    ['address', readNonEmptyString(logValue.address)],
    ['contractAddress', readNonEmptyString(logValue.contractAddress)],
    ['tokenAddress', readNonEmptyString(logValue.tokenAddress)],
    ['mint', readNonEmptyString(logValue.mint)],
    ['transactionHash', readNonEmptyString(logValue.transactionHash)],
    ['type', readNonEmptyString(logValue.type)],
    ['category', readNonEmptyString(logValue.category)],
    ['walletAddress', readNonEmptyString(logValue.walletAddress)],
    ['amount', logValue.amount],
    ['value', logValue.value],
    ['tokenAmount', logValue.tokenAmount],
    ['fee', logValue.fee],
    ['feeUsd', logValue.feeUsd],
    ['feeUSD', logValue.feeUSD],
    [
      'transaction',
      compactDefinedRecord([
        ['from', compactAddressParticipant(transaction?.from)],
        ['to', compactAddressParticipant(transaction?.to)],
      ]),
    ],
  ]);
}

function buildCompactAlchemyActivityPayload(
  activityValue: Record<string, unknown>,
): Record<string, unknown> {
  const rawContract = isRecord(activityValue.rawContract) ? activityValue.rawContract : null;
  const log = isRecord(activityValue.log) ? activityValue.log : null;
  const tokenTransfers = Array.isArray(activityValue.tokenTransfers)
    ? activityValue.tokenTransfers.filter((item) => isRecord(item)).map((item) => {
        const record = item as Record<string, unknown>;
        return compactDefinedRecord([
          ['mint', readNonEmptyString(record.mint)],
          ['tokenAddress', readNonEmptyString(record.tokenAddress)],
          ['contractAddress', readNonEmptyString(record.contractAddress)],
          ['sender', readNonEmptyString(record.sender)],
          ['receiver', readNonEmptyString(record.receiver)],
          ['sourceOwner', readNonEmptyString(record.sourceOwner)],
          ['destinationOwner', readNonEmptyString(record.destinationOwner)],
          ['fromAddress', readNonEmptyString(record.fromAddress)],
          ['toAddress', readNonEmptyString(record.toAddress)],
          ['amount', record.amount],
          ['value', record.value],
          ['tokenAmount', record.tokenAmount],
        ]);
      })
    : null;
  return compactDefinedRecord([
    ['hash', readNonEmptyString(activityValue.hash)],
    ['type', readNonEmptyString(activityValue.type)],
    ['side', readNonEmptyString(activityValue.side)],
    ['category', readNonEmptyString(activityValue.category)],
    ['asset', readNonEmptyString(activityValue.asset)],
    ['fromAddress', readNonEmptyString(activityValue.fromAddress)],
    ['toAddress', readNonEmptyString(activityValue.toAddress)],
    ['walletAddress', readNonEmptyString(activityValue.walletAddress)],
    ['contractAddress', readNonEmptyString(activityValue.contractAddress)],
    ['tokenAddress', readNonEmptyString(activityValue.tokenAddress)],
    ['mint', readNonEmptyString(activityValue.mint)],
    ['amount', activityValue.amount],
    ['value', activityValue.value],
    ['tokenAmount', activityValue.tokenAmount],
    ['fee', activityValue.fee],
    ['feeUsd', activityValue.feeUsd],
    ['feeUSD', activityValue.feeUSD],
    ['tokenTransfers', tokenTransfers],
    [
      'rawContract',
      compactDefinedRecord([
        ['address', readNonEmptyString(rawContract?.address)],
      ]),
    ],
    ['log', buildCompactAlchemyLogPayload(log)],
  ]);
}

function buildCompactAlchemySignalPayload(input: {
  webhookId: string | null;
  eventId: string;
  type: string;
  txSignature: string | null;
  contractAddresses: string[];
  activity?: Record<string, unknown> | null;
  log?: Record<string, unknown> | null;
}): string {
  return JSON.stringify(
    compactDefinedRecord([
      ['webhookId', input.webhookId],
      ['eventId', input.eventId],
      ['type', input.type],
      ['txSignature', input.txSignature],
      ['contractAddresses', input.contractAddresses],
      ['activity', input.activity ? buildCompactAlchemyActivityPayload(input.activity) : null],
      ['log', buildCompactAlchemyLogPayload(input.log ?? null)],
    ]),
  );
}

function deriveAlchemySignalsFromPayload(
  payload: AlchemyWebhookPayload,
  defaultContractAddress: string | null,
): DerivedChainSignal[] {
  const webhookId = readNonEmptyString(payload.webhookId);
  const eventId = readNonEmptyString(payload.id) ?? `alchemy-${nowTs()}`;
  const payloadType = readNonEmptyString(payload.type) ?? 'ALCHEMY_NOTIFY';
  const event = isRecord(payload.event) ? payload.event : null;
  const fallbackContracts = defaultContractAddress ? [defaultContractAddress] : [];

  if (event && Array.isArray(event.activity)) {
    const activitySignals = event.activity.flatMap((item, index) => {
      if (!isRecord(item)) {
        return [];
      }
      const rawContract = isRecord(item.rawContract) ? item.rawContract : null;
      const log = isRecord(item.log) ? item.log : null;
      const txSignature =
        readNonEmptyString(item.hash) ??
        readNonEmptyString(log?.transactionHash) ??
        null;
      const contractAddresses = uniqueSolanaPubkeys([
        ...fallbackContracts,
        rawContract?.address,
        item.contractAddress,
        item.tokenAddress,
        item.mint,
        log?.address,
        log?.contractAddress,
        log?.tokenAddress,
        log?.mint,
        ...extractTokenTransferContractAddresses(item.tokenTransfers),
      ]);
      return [
        {
          externalId: `${eventId}:${txSignature ?? index}:${index}`,
          eventType: `${payloadType}:${readNonEmptyString(item.category) ?? 'activity'}`,
          walletAddress:
            tryNormalizeSolanaPubkey(item.walletAddress) ??
            tryNormalizeSolanaPubkey(item.fromAddress) ??
            tryNormalizeSolanaPubkey(item.toAddress),
          txSignature,
          contractAddresses,
          payload: buildCompactAlchemySignalPayload({
            webhookId,
            eventId,
            type: payloadType,
            txSignature,
            contractAddresses,
            activity: item,
          }),
        } satisfies DerivedChainSignal,
      ];
    });
    if (activitySignals.length > 0) {
      return activitySignals;
    }
  }

  const data = event && isRecord(event.data) ? event.data : null;
  const block = data && isRecord(data.block) ? data.block : null;
  if (block && Array.isArray(block.logs)) {
    const logSignals = block.logs.flatMap((item, index) => {
      if (!isRecord(item)) {
        return [];
      }
      const transaction = isRecord(item.transaction) ? item.transaction : null;
      const from = transaction && isRecord(transaction.from) ? transaction.from : null;
      const to = transaction && isRecord(transaction.to) ? transaction.to : null;
      const account = isRecord(item.account) ? item.account : null;
      const txSignature =
        readNonEmptyString(transaction?.hash) ??
        readNonEmptyString(item.transactionHash) ??
        null;
      const contractAddresses = uniqueSolanaPubkeys([
        ...fallbackContracts,
        account?.address,
        item.address,
        item.contractAddress,
        item.tokenAddress,
        item.mint,
      ]);
      return [
        {
          externalId: `${eventId}:${txSignature ?? index}:${index}`,
          eventType: `${payloadType}:log`,
          walletAddress:
            tryNormalizeSolanaPubkey(from?.address) ??
            tryNormalizeSolanaPubkey(to?.address),
          txSignature,
          contractAddresses,
          payload: buildCompactAlchemySignalPayload({
            webhookId,
            eventId,
            type: payloadType,
            txSignature,
            contractAddresses,
            log: item,
          }),
        } satisfies DerivedChainSignal,
      ];
    });
    if (logSignals.length > 0) {
      return logSignals;
    }
  }

  return [
    {
      externalId: eventId,
      eventType: payloadType,
      walletAddress: null,
      txSignature: null,
      contractAddresses: uniqueSolanaPubkeys([
        ...fallbackContracts,
        event?.contractAddress,
        event?.address,
        event?.tokenAddress,
        event?.mint,
      ]),
      payload: JSON.stringify(
        compactDefinedRecord([
          ['webhookId', webhookId],
          ['eventId', eventId],
          ['type', payloadType],
          [
            'contractAddresses',
            uniqueSolanaPubkeys([
              ...fallbackContracts,
              event?.contractAddress,
              event?.address,
              event?.tokenAddress,
              event?.mint,
            ]),
          ],
        ]),
      ),
    },
  ];
}

async function processTokenActivitySignal(
  env: Env,
  input: {
    userId: number;
    contractAddress: string;
    source: string;
    externalId: string;
    eventType: string;
    walletAddress: string | null;
    txSignature: string | null;
    payload: string;
    providerLabel: string;
  },
): Promise<boolean> {
  const normalizedContractAddress = normalizePubkey(input.contractAddress);
  const signalTarget = await resolveSignalStorageTarget(env, {
    userId: input.userId,
    source: input.source,
    externalId: input.externalId,
    eventType: input.eventType,
    walletAddress: input.walletAddress,
    txSignature: input.txSignature,
    payload: input.payload,
    detailsJson: null,
  });
  const inserted = signalTarget.inserted;
  const targetSource = signalTarget.signal.source;
  const targetExternalId = signalTarget.signal.externalId;

  if (!inserted && !signalTarget.reusedByTxSignature) {
    if (signalTarget.signal.processed) {
      return false;
    }
    const claimed = await dbClaimSignalProcessing(
      env.TRADINGBOT_DB,
      targetSource,
      targetExternalId,
    );
    if (!claimed) {
      return false;
    }
  }

  let latestChainTimeMs: number | null = null;
  try {
    let latestDetails = mergeStoredSignalTransactionDetails({
      tokenContractAddress: normalizedContractAddress,
      primaryWalletAddress: input.walletAddress,
      transactionStatus: 'PENDING',
      detailSource: 'unknown',
      source: 'webhook',
    });
    let latestWalletAddress = input.walletAddress;
    const rpcUrls = await dbResolveSolanaRpcUrls(
      env.TRADINGBOT_DB,
      input.userId,
      env.SOLANA_RPC_URL,
    );
    const tokenId = await dbResolveTradableTokenId(
      env.TRADINGBOT_DB,
      normalizedContractAddress,
    );
    const trackedToken = tokenId != null
      ? await dbFindTradableTokenById(env.TRADINGBOT_DB, tokenId)
      : null;
    const payloadDetails = extractWebhookTransactionDetailsFromPayload(
      input.payload,
      normalizedContractAddress,
    );
    const rpcResult = input.txSignature
      ? await fetchSolanaWebhookTransactionDetailsFromRpc(
          rpcUrls,
          input.txSignature,
          normalizedContractAddress,
          payloadDetails,
        )
      : null;
    latestChainTimeMs = rpcResult?.chainTimeMs ?? null;
    const mergedDetails = mergeStoredSignalTransactionDetails(
      {
        tokenContractAddress: normalizedContractAddress,
        primaryWalletAddress: input.walletAddress,
        transactionStatus: 'PENDING',
        detailSource: 'unknown',
      },
      payloadDetails,
      rpcResult?.details,
    );
    const correctedDetails = applyAmmPoolDirectionCorrection(
      mergedDetails,
      trackedToken?.ammPoolAddress,
      payloadDetails,
    );
    const preferredWalletAddress = await dbResolvePreferredSignalWalletAddress(
      env.TRADINGBOT_DB,
      input.userId,
      [
        correctedDetails.primaryWalletAddress,
        correctedDetails.fromWalletAddress,
        correctedDetails.toWalletAddress,
      ],
      input.walletAddress,
    );
    correctedDetails.primaryWalletAddress = preferredWalletAddress;
    latestDetails = correctedDetails;
    latestWalletAddress = preferredWalletAddress ?? input.walletAddress;
    await dbUpdateSignalTransactionDetails(
      env.TRADINGBOT_DB,
      targetSource,
      targetExternalId,
      preferredWalletAddress,
      correctedDetails,
    );
    if (tokenId && input.txSignature) {
      await dbApplyTokenHolderTransactionDelta(
        env.TRADINGBOT_DB,
        input.userId,
        tokenId,
        input.txSignature,
        correctedDetails,
      ).catch((err) => {
        console.warn(`Failed to apply token holder delta for ${input.txSignature}:`, err);
      });
    }
    await dbUpsertWebhookTransactionLog(env.TRADINGBOT_DB, {
      userId: input.userId,
      tokenId,
      tokenContractAddress: normalizedContractAddress,
      source: correctedDetails.source,
      eventType: input.eventType,
      txSignature: input.txSignature,
      externalId: input.externalId,
      walletAddress: latestWalletAddress,
      details: latestDetails,
      processed: true,
      errorMessage: null,
      chainTimeMs: latestChainTimeMs,
      createdAt: signalTarget.signal.createdAt,
      metadata: {
        updateReason: 'alchemy_notify_process',
        providerLabel: input.providerLabel,
        signalSource: input.source,
        chainTimeMs: latestChainTimeMs,
      },
    });

    let marketSnapshot: TokenMarketSnapshot | null = null;
    try {
      marketSnapshot = await syncTokenMarketSnapshotForUser(
        env.TRADINGBOT_DB,
        input.userId,
        'solana',
        normalizedContractAddress,
        rpcUrls,
        {
          force: true,
        },
      );
    } catch (err: unknown) {
      console.warn(
        `Failed to refresh market snapshot from ${input.providerLabel} event for ${normalizedContractAddress}:`,
        err,
      );
    }

    let strategySummary: string | null = null;
    try {
      const settings = await dbLoadSettings(env.TRADINGBOT_DB, input.userId);
      const strategyResult = await runAndPersistStrategyEvaluation(
        env.TRADINGBOT_DB,
        input.userId,
        {
          baseTokenAddress: settings.activeBaseTokenAddress?.trim() || settings.baseTokenAddress,
          quoteTokenAddress: settings.activeQuoteTokenAddress?.trim() || '',
          volatilityTarget: settings.volatilityTarget,
          pullbackTarget: settings.pullbackTarget,
          volumeTarget: settings.volumeTarget,
          netBuyinTarget: settings.netBuyinTarget,
          timeRangeTarget: settings.timeRangeTarget,
          maxTransactions: settings.maxTransactions,
          maxSlippage: settings.maxSlippage,
          strategyNotes: settings.strategyNotes,
        },
        buildWebhookStrategyTrigger({
          eventType: input.eventType,
          externalId: input.externalId,
          contractAddress: normalizedContractAddress,
          walletAddress: preferredWalletAddress ?? input.walletAddress,
          txSignature: input.txSignature,
          payloadJson: input.payload,
        }),
        marketSnapshot,
        {
          changeNote: `Webhook trigger ${input.eventType}`,
          origin: 'settings-sync',
        },
      );

      const activeStrategy = await getActiveStrategy(env);
      if (
        strategyResult &&
        activeStrategy &&
        activeStrategy.config.baseTokenAddress === normalizedContractAddress &&
        activeStrategy.config.strategyVersionId === strategyResult.version.id
      ) {
        const strategyAction = correctedDetails.action;
        if (strategyAction === 'BUY' || strategyAction === 'SELL') {
          const stubId = env.STRATEGY_ENGINE_DO.idFromName(
            `${input.userId}:${normalizedContractAddress}`,
          );
          const stub = env.STRATEGY_ENGINE_DO.get(stubId);
          const forwardRequest: StrategyEngineDurableObjectEventRequest = {
            userId: input.userId,
            versionId: strategyResult.version.id,
            strategyDocument: strategyResult.version.document,
            event: {
              type: strategyAction === 'SELL' ? 'whale_sell' : 'whale_buy',
              amount: Math.max(
                0,
                correctedDetails.usdcAmount ?? correctedDetails.tokenAmount ?? 0,
              ),
              contractAddress: normalizedContractAddress,
              txHash: input.txSignature ?? input.externalId,
              wallet_address:
                preferredWalletAddress ?? input.walletAddress ?? normalizedContractAddress,
              is_loss_cut: false,
              payloadJson: input.payload,
            },
          };
          await stub.fetch('https://strategy-engine/webhook', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(forwardRequest),
          });
        }
      }
      strategySummary = strategyResult
        ? `Strategy v${strategyResult.version.versionNo}: ${summarizeStrategyRuntime(strategyResult.runtime)}`
        : 'No manual strategy version is active, so the webhook did not create an evaluation.';
    } catch (err: unknown) {
      console.warn(
        `Strategy evaluation failed for webhook ${input.eventType} on ${normalizedContractAddress}:`,
        err,
      );
    }

    await dbAddAuditLog(
      env.TRADINGBOT_DB,
      input.userId,
      'strategy.triggered',
      input.txSignature ?? input.externalId,
      marketSnapshot
        ? `Received an ${input.providerLabel} ${input.eventType} event for ${normalizedContractAddress}. Recorded a fresh market snapshot and triggered strategy evaluation. ${strategySummary ?? 'Strategy runtime is not yet actionable for automated execution.'}`
        : `Received an ${input.providerLabel} ${input.eventType} event for ${normalizedContractAddress}. Triggered strategy evaluation. ${strategySummary ?? 'Strategy runtime is not yet actionable for automated execution.'}`,
    );
    await dbMarkSignalProcessed(
      env.TRADINGBOT_DB,
      targetSource,
      targetExternalId,
    );
    return true;
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    await dbMarkSignalFailed(
      env.TRADINGBOT_DB,
      targetSource,
      targetExternalId,
      errorMessage,
    );
    await dbUpsertWebhookTransactionLog(env.TRADINGBOT_DB, {
      userId: input.userId,
      tokenId: null,
      tokenContractAddress: normalizedContractAddress,
      source: 'webhook',
      eventType: input.eventType,
      txSignature: input.txSignature,
      externalId: input.externalId,
      walletAddress: input.walletAddress,
      details: {
        tokenContractAddress: normalizedContractAddress,
        fromWalletAddress: null,
        toWalletAddress: null,
        primaryWalletAddress: input.walletAddress,
        action: null,
        usdcAmount: null,
        tokenAmount: null,
        feeAmountUsd: null,
        source: 'webhook',
        transactionStatus: 'PENDING',
        detailSource: 'unknown',
      },
      processed: false,
      errorMessage,
      chainTimeMs: latestChainTimeMs,
      createdAt: signalTarget.signal.createdAt,
      metadata: {
        updateReason: 'alchemy_notify_failed',
        providerLabel: input.providerLabel,
        signalSource: input.source,
        chainTimeMs: latestChainTimeMs,
      },
    });
    throw err;
  }
}

async function processAlchemyNotifyWebhookPayload(
  env: Env,
  payload: AlchemyWebhookPayload,
  contractFromQuery: string | null,
  derivedSignals: DerivedChainSignal[],
): Promise<{
  received: number;
  routedTargets: number;
  processed: number;
  duplicates: number;
  ignored: number;
}> {
  const webhookId = readNonEmptyString(payload.webhookId) ?? 'shared';
  const targetCache = new Map<string, number[]>();

  let processed = 0;
  let duplicates = 0;
  let ignored = 0;
  let routedTargets = 0;

  for (const signal of derivedSignals) {
    const contractAddresses = signal.contractAddresses.length > 0
      ? signal.contractAddresses
      : contractFromQuery
        ? [contractFromQuery]
        : [];
    if (contractAddresses.length === 0) {
      ignored += 1;
      continue;
    }

    const handledTargets = new Set<string>();
    for (const contractAddress of contractAddresses) {
      let userIds = targetCache.get(contractAddress);
      if (!userIds) {
        userIds = await dbListUserIdsByActiveContractAddress(
          env.TRADINGBOT_DB,
          contractAddress,
        );
        targetCache.set(contractAddress, userIds);
      }

      for (const userId of userIds) {
        const targetKey = `${userId}:${contractAddress}`;
        if (handledTargets.has(targetKey)) {
          continue;
        }
        handledTargets.add(targetKey);
        routedTargets += 1;
        const inserted = await processTokenActivitySignal(env, {
          userId,
          contractAddress,
          source: `alchemy_notify:${webhookId}:user:${userId}`,
          externalId: `${signal.externalId}:${contractAddress}`,
          eventType: signal.eventType,
          walletAddress: signal.walletAddress,
          txSignature: signal.txSignature,
          payload: signal.payload,
          providerLabel: 'Alchemy Notify',
        });
        if (inserted) {
          processed += 1;
        } else {
          duplicates += 1;
        }
      }
    }

    if (handledTargets.size === 0) {
      ignored += 1;
    }
  }

  return {
    received: derivedSignals.length,
    routedTargets,
    processed,
    duplicates,
    ignored,
  };
}

async function handleAlchemyNotifyWebhook(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const backgroundRequest = request.clone();
  const contractFromQuery = tryNormalizeSolanaPubkey(
    url.searchParams.get('contractAddress'),
  );

  ctx.waitUntil(
    (async () => {
      try {
        const rawBody = await backgroundRequest.text();
        await assertAlchemyWebhookSignature(request, env, rawBody);
        const payload = parseJsonText<AlchemyWebhookPayload>(rawBody);
        const derivedSignals = deriveAlchemySignalsFromPayload(
          payload,
          contractFromQuery,
        );
        const result = await processAlchemyNotifyWebhookPayload(
          env,
          payload,
          contractFromQuery,
          derivedSignals,
        );
        console.log(
          `[webhook] Routed ${result.routedTargets} targets, processed ${result.processed} signal(s), duplicates ${result.duplicates}, ignored ${result.ignored}`,
        );
      } catch (err) {
        console.error('Alchemy webhook background processing failed:', err);
      }
    })(),
  );

  return jsonResponse({ ok: true, accepted: true }, 200);
}

