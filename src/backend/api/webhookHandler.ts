import { summarizeStrategyRuntime } from '../strategy/runtime';
import { buildWebhookStrategyTrigger } from '../strategy/triggers';
import { nowTs } from '../time';
import { dbResolveSolanaRpcUrls, dbResolveTradableTokenId } from '../tokenStore';
import { dbAddAuditLog, dbLoadSettings } from '../userStore';
import type {
  AlchemyWebhookPayload,
  DerivedChainSignal,
  Env,
  TokenMarketSnapshot,
} from '../workerShared';
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
import {
  dbApplyTokenHolderTransactionDelta,
  dbClaimSignalProcessing,
  dbCreateSignal,
  dbMarkSignalFailed,
  dbMarkSignalProcessed,
  dbResolvePreferredSignalWalletAddress,
  dbUpdateSignalTransactionDetails,
  fetchSolanaWebhookTransactionDetailsFromRpc,
} from '../services/signalStore';
import { runAndPersistStrategyEvaluation } from '../services/strategyStore';
import { syncTokenMarketSnapshotForUser } from '../services/tokenMarketService';

export async function handleWebhookRoutes(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method === 'POST' && url.pathname === '/api/webhooks/alchemy/notify') {
    return handleAlchemyNotifyWebhook(request, url, env, ctx);
  }
  return null;
}

async function dbListUserIdsByActiveContractAddress(
  db: D1Database,
  contractAddress: string,
): Promise<number[]> {
  await dbEnsureSchema(db);
  const rows = await db
    .prepare(
      `SELECT DISTINCT user_id
       FROM settings
       WHERE key = ?1 AND value = ?2
       ORDER BY user_id ASC`,
    )
    .bind('contractAddress', normalizePubkey(contractAddress))
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

async function loadStoredMarketSnapshotByContractAddress(
  db: D1Database,
  contractAddress: string,
): Promise<TokenMarketSnapshot | null> {
  const tokenId = await dbResolveTradableTokenId(db, contractAddress);
  if (!tokenId) {
    return null;
  }
  return dbGetLatestTokenMarketSnapshot(db, tokenId);
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
      ]);
      return [
        {
          externalId: `${eventId}:${txSignature ?? index}:${index}`,
          eventType: `${payloadType}:${readNonEmptyString(item.category) ?? 'activity'}`,
          walletAddress:
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
  const { inserted, signal } = await dbCreateSignal(env.TRADINGBOT_DB, {
    source: input.source,
    externalId: input.externalId,
    eventType: input.eventType,
    walletAddress: input.walletAddress,
    txSignature: input.txSignature,
    payload: input.payload,
    detailsJson: null,
  });

  if (!inserted) {
    if (signal.processed) {
      return false;
    }
    const claimed = await dbClaimSignalProcessing(
      env.TRADINGBOT_DB,
      input.source,
      input.externalId,
    );
    if (!claimed) {
      return false;
    }
  }

  try {
    const rpcUrls = await dbResolveSolanaRpcUrls(
      env.TRADINGBOT_DB,
      input.userId,
      env.SOLANA_RPC_URL,
    );
    const tokenId = await dbResolveTradableTokenId(
      env.TRADINGBOT_DB,
      normalizedContractAddress,
    );
    const payloadDetails = extractWebhookTransactionDetailsFromPayload(
      input.payload,
      normalizedContractAddress,
    );
    const rpcDetails = input.txSignature
      ? await fetchSolanaWebhookTransactionDetailsFromRpc(
          rpcUrls,
          input.txSignature,
          normalizedContractAddress,
          payloadDetails,
        )
      : null;
    const mergedDetails = mergeStoredSignalTransactionDetails(
      {
        tokenContractAddress: normalizedContractAddress,
        primaryWalletAddress: input.walletAddress,
        transactionStatus: 'PENDING',
        detailSource: 'unknown',
      },
      payloadDetails,
      rpcDetails,
    );
    const preferredWalletAddress = await dbResolvePreferredSignalWalletAddress(
      env.TRADINGBOT_DB,
      input.userId,
      [
        mergedDetails.primaryWalletAddress,
        mergedDetails.fromWalletAddress,
        mergedDetails.toWalletAddress,
      ],
      input.walletAddress,
    );
    mergedDetails.primaryWalletAddress = preferredWalletAddress;
    await dbUpdateSignalTransactionDetails(
      env.TRADINGBOT_DB,
      input.source,
      input.externalId,
      preferredWalletAddress,
      mergedDetails,
    );
    if (tokenId && input.txSignature) {
      await dbApplyTokenHolderTransactionDelta(
        env.TRADINGBOT_DB,
        input.userId,
        tokenId,
        input.txSignature,
        mergedDetails,
      ).catch((err) => {
        console.warn(`Failed to apply token holder delta for ${input.txSignature}:`, err);
      });
    }

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
        settings,
        buildWebhookStrategyTrigger({
          eventType: input.eventType,
          externalId: input.externalId,
          contractAddress: normalizedContractAddress,
          walletAddress: input.walletAddress,
          txSignature: input.txSignature,
          payloadJson: null,
        }),
        marketSnapshot,
        {
          changeNote: `Webhook trigger ${input.eventType}`,
          origin: 'settings-sync',
        },
      );
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
      input.source,
      input.externalId,
    );
    return true;
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    await dbMarkSignalFailed(
      env.TRADINGBOT_DB,
      input.source,
      input.externalId,
      errorMessage,
    );
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
  const rawBody = await request.text();
  await assertAlchemyWebhookSignature(request, env, rawBody);
  const payload = parseJsonText<AlchemyWebhookPayload>(rawBody);
  const contractFromQuery = tryNormalizeSolanaPubkey(
    url.searchParams.get('contractAddress'),
  );
  const derivedSignals = deriveAlchemySignalsFromPayload(
    payload,
    contractFromQuery,
  );

  // Background processing: handle webhook and update market snapshots
  ctx.waitUntil(
    (async () => {
      try {
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

