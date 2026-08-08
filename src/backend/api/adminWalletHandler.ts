import { ApiError } from '../errors';
import { parseManagedWalletImportRequest, parseJsonBody } from '../workerSchema';
import { dbListTradableTokens, dbResolveSolanaRpcUrls } from '../tokenStore';
import {
  dbAddAuditLog,
  dbDeleteOtherSessions,
  dbImportManagedKey,
  dbImportManagedKeyBytes,
  dbLoadSettings,
  dbVerifyUserPassword,
} from '../userStore';
import {
  buildSolanaAccountDerivationPath,
  deriveSolanaKeypairsFromRecoveryPhrase,
  executeTradeTask,
  hashPassword,
  jsonResponse,
  loadWalletBalance,
  normalizePubkey,
  sessionTokenFromCookie,
  solanaPubkeyFromKeypairBytes,
  validatePassword,
  verifyPassword,
} from '../workerCore';
import { DEFAULT_SOLANA_DERIVATION_PATH } from '../workerShared';
import type { Env } from '../workerShared';
import { requireAdmin, requireUser } from '../services/accessControl';
import { buildStrategyTaskExecutionContext } from '../services/strategyAutomationService';
import { dbUserOwnsAccount } from '../services/strategyStore';

const DEFAULT_RECOVERY_PHRASE_DERIVED_ACCOUNT_COUNT = 20;
const MAX_RECOVERY_PHRASE_DERIVED_ACCOUNT_COUNT = 100;

type DerivedManagedAccountCandidate = {
  accountIndex: number;
  derivationPath: string;
  keypairBytes: Uint8Array;
  address: string;
};

function clampDerivedAccountCount(value: number | undefined): number {
  return Math.min(
    Math.max(value ?? DEFAULT_RECOVERY_PHRASE_DERIVED_ACCOUNT_COUNT, 1),
    MAX_RECOVERY_PHRASE_DERIVED_ACCOUNT_COUNT,
  );
}

function buildManagedAccountLabel(baseLabel: string, accountIndex: number): string {
  const trimmed = baseLabel.trim();
  if (accountIndex === 0) {
    return trimmed;
  }
  const suffix = ` #${accountIndex + 1}`;
  return `${trimmed.slice(0, Math.max(3, 80 - suffix.length)).trim()}${suffix}`;
}

async function deriveRecoveryPhraseAccounts(
  recoveryPhrase: string,
  baseDerivationPath: string,
  derivedAccountCount: number,
): Promise<DerivedManagedAccountCandidate[]> {
  const derivationPaths = Array.from(
    { length: derivedAccountCount },
    (_, accountIndex) => buildSolanaAccountDerivationPath(accountIndex, baseDerivationPath),
  );
  const keypairBytesList = deriveSolanaKeypairsFromRecoveryPhrase(
    recoveryPhrase,
    derivationPaths,
  );
  const candidates = keypairBytesList.map((keypairBytes, accountIndex) => ({
    accountIndex,
    derivationPath: derivationPaths[accountIndex],
    keypairBytes,
    address: solanaPubkeyFromKeypairBytes(keypairBytes),
  }));
  return candidates;
}

export async function handleAdminWalletRoutes(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const url = new URL(request.url);
  const { method } = request;
  const { pathname } = url;

  if (
    method === 'POST' &&
    (pathname === '/api/private-keys/import' || pathname === '/api/admin/private-keys')
  ) {
    if (!env.PRIVATE_KEY_ENCRYPTION_KEY) {
      throw new ApiError(
        503,
        'PRIVATE_KEY_ENCRYPTION_KEY is not configured on the server',
      );
    }
    const user = await requireAdmin(request, env);
    const body = parseManagedWalletImportRequest(
      await parseJsonBody<unknown>(request),
    );
    if (body.adminPassword) {
      const passwordValid = await dbVerifyUserPassword(
        env.TRADINGBOT_DB,
        user.id,
        body.adminPassword,
      );
      if (!passwordValid) {
        throw new ApiError(401, 'Admin password is incorrect');
      }
    }
    if (body.privateKey) {
      const account = await dbImportManagedKey(
        env.TRADINGBOT_DB,
        user.id,
        body.label,
        body.privateKey,
        env.PRIVATE_KEY_ENCRYPTION_KEY,
      );
      await dbAddAuditLog(
        env.TRADINGBOT_DB,
        user.id,
        'private_key.imported',
        account.address,
        `Imported managed key '${account.label}' from a private key. Private key material was encrypted at rest and is never returned by the API.`,
      );
      return jsonResponse({ account, accounts: [account], importedCount: 1 }, 201);
    }

    const baseDerivationPath = body.derivationPath ?? DEFAULT_SOLANA_DERIVATION_PATH;
    const derivedAccountCount = clampDerivedAccountCount(body.derivedAccountCount);
    const derivedAccounts = await deriveRecoveryPhraseAccounts(
      body.recoveryPhrase ?? '',
      baseDerivationPath,
      derivedAccountCount,
    );

    const existingAddresses = new Set(
      (
        await env.TRADINGBOT_DB
          .prepare(
            "SELECT wallet_address FROM accounts WHERE user_id = ?1 AND type = 'managed'",
          )
          .bind(user.id)
          .all<{ wallet_address: string }>()
      ).results.map((row) => row.wallet_address),
    );

    const missingDerivedAccounts = derivedAccounts.filter(
      (derivedAccount) => !existingAddresses.has(derivedAccount.address),
    );

    if (missingDerivedAccounts.length === 0) {
      throw new ApiError(409, 'All requested derived accounts have already been imported');
    }

    const importedAccounts = [];
    for (const derivedAccount of missingDerivedAccounts) {
      const account = await dbImportManagedKeyBytes(
        env.TRADINGBOT_DB,
        user.id,
        buildManagedAccountLabel(body.label, derivedAccount.accountIndex),
        derivedAccount.keypairBytes,
        env.PRIVATE_KEY_ENCRYPTION_KEY,
      );
      importedAccounts.push(account);
      await dbAddAuditLog(
        env.TRADINGBOT_DB,
        user.id,
        'private_key.imported',
        account.address,
        `Imported managed key '${account.label}' from a recovery phrase using ${derivedAccount.derivationPath}. Derived key material was encrypted at rest and is never returned by the API.`,
      );
    }

    return jsonResponse(
      {
        account: importedAccounts[0],
        accounts: importedAccounts,
        importedCount: importedAccounts.length,
        requestedDerivedAccountCount: derivedAccountCount,
      },
      201,
    );
  }

  if (method === 'POST' && pathname === '/api/admin/private-keys/preview') {
    const user = await requireAdmin(request, env);
    const body = parseManagedWalletImportRequest(
      await parseJsonBody<unknown>(request),
    );
    if (!body.recoveryPhrase) {
      throw new ApiError(400, 'Recovery phrase is required');
    }
    if (body.adminPassword) {
      const passwordValid = await dbVerifyUserPassword(
        env.TRADINGBOT_DB,
        user.id,
        body.adminPassword,
      );
      if (!passwordValid) {
        throw new ApiError(401, 'Admin password is incorrect');
      }
    }

    const baseDerivationPath = body.derivationPath ?? DEFAULT_SOLANA_DERIVATION_PATH;
    const derivedAccountCount = clampDerivedAccountCount(body.derivedAccountCount);
    const derivedAccounts = await deriveRecoveryPhraseAccounts(
      body.recoveryPhrase,
      baseDerivationPath,
      derivedAccountCount,
    );
    const existingAddresses = new Set(
      (
        await env.TRADINGBOT_DB
          .prepare(
            "SELECT wallet_address FROM accounts WHERE user_id = ?1 AND type = 'managed'",
          )
          .bind(user.id)
          .all<{ wallet_address: string }>()
      ).results.map((row) => row.wallet_address),
    );

    return jsonResponse({
      accounts: derivedAccounts.map((account) => ({
        accountIndex: account.accountIndex,
        derivationPath: account.derivationPath,
        address: account.address,
        alreadyImported: existingAddresses.has(account.address),
      })),
      derivedAccountCount,
    });
  }

  if (method === 'POST' && pathname === '/api/trade') {
    const user = await requireAdmin(request, env);
    const body = await request.json<{
      action?: string;
      contractAddress?: string;
      walletAddress?: string;
      accountId?: number;
      requestedAmount?: number;
    }>();

    const action = (body.action ?? '').toUpperCase();
    if (action !== 'BUY' && action !== 'SELL') {
      throw new ApiError(400, 'action must be BUY or SELL');
    }
    if (
      typeof body.requestedAmount !== 'number' ||
      !Number.isFinite(body.requestedAmount) ||
      body.requestedAmount <= 0
    ) {
      throw new ApiError(400, 'requestedAmount must be a positive number');
    }

    const result = await executeTradeTask(
      {
        action,
        accountId:
          typeof body.accountId === 'number' && Number.isInteger(body.accountId)
            ? body.accountId
            : null,
        walletAddress:
          typeof body.walletAddress === 'string' && body.walletAddress.trim().length > 0
            ? body.walletAddress
            : null,
        contractAddress:
          typeof body.contractAddress === 'string' && body.contractAddress.trim().length > 0
            ? body.contractAddress
            : null,
        requestedAmount: body.requestedAmount,
        scheduledAt: Date.now(),
      },
      buildStrategyTaskExecutionContext(env, user.id, user.username),
    );

    return jsonResponse(result);
  }

  if (method === 'POST' && pathname === '/api/admin/password') {
    const user = await requireAdmin(request, env);
    const currentToken = sessionTokenFromCookie(request.headers.get('Cookie'));
    const body = await request.json<{ oldPassword: string; newPassword: string }>();

    if (!body.oldPassword || !body.newPassword) {
      throw new ApiError(400, 'Old and new passwords are required');
    }

    const dbUser = await env.TRADINGBOT_DB
      .prepare('SELECT password_hash FROM users WHERE id = ?1')
      .bind(user.id)
      .first<{ password_hash: string }>();

    if (!dbUser) throw new ApiError(401, 'User not found');

    const oldPasswordValid = await verifyPassword(body.oldPassword, dbUser.password_hash);
    if (!oldPasswordValid) throw new ApiError(401, 'Old password is incorrect');

    validatePassword(body.newPassword);
    const newPasswordHash = await hashPassword(body.newPassword);

    await env.TRADINGBOT_DB
      .prepare('UPDATE users SET password_hash = ?1 WHERE id = ?2')
      .bind(newPasswordHash, user.id)
      .run();
    await dbDeleteOtherSessions(env.TRADINGBOT_DB, user.id, currentToken);

    await dbAddAuditLog(
      env.TRADINGBOT_DB,
      user.id,
      'admin.password_changed',
      user.username,
      'Admin password was changed',
    );

    return jsonResponse({ success: true, message: 'Password updated successfully' }, 200);
  }

  if (method === 'GET' && /^\/api\/wallets\/[^/]+\/balance$/.test(pathname)) {
    const user = await requireUser(request, env);
    const addressPath = decodeURIComponent(url.pathname.split('/')[3] ?? '');
    const address = normalizePubkey(addressPath);
    const ownsAccount = await dbUserOwnsAccount(
      env.TRADINGBOT_DB,
      user.id,
      address,
    );
    if (!ownsAccount) {
      throw new ApiError(404, 'Wallet not found for the current user');
    }
    const [settings, tradableTokens] = await Promise.all([
      dbLoadSettings(env.TRADINGBOT_DB, user.id),
      dbListTradableTokens(env.TRADINGBOT_DB),
    ]);
    const rpcUrls = await dbResolveSolanaRpcUrls(
      env.TRADINGBOT_DB,
      user.id,
      env.SOLANA_RPC_URL,
    );
    const balance = await loadWalletBalance(
      address,
      settings,
      tradableTokens,
      rpcUrls,
    );
    return jsonResponse(balance);
  }

  if (method === 'DELETE' && pathname.startsWith('/api/admin/private-keys/')) {
    const user = await requireAdmin(request, env);
    const adminPasswordHeader = request.headers.get('Authorization')?.trim();
    if (adminPasswordHeader) {
      const passwordValid = await dbVerifyUserPassword(
        env.TRADINGBOT_DB,
        user.id,
        adminPasswordHeader,
      );
      if (!passwordValid) {
        throw new ApiError(401, 'Admin password is incorrect');
      }
    }
    const addressPath = url.pathname.split('/').pop();

    if (!addressPath) {
      throw new ApiError(400, 'Wallet address is required');
    }

    const account = await env.TRADINGBOT_DB
      .prepare(
        "SELECT id, label FROM accounts WHERE user_id = ?1 AND wallet_address = ?2 AND type = 'managed'",
      )
      .bind(user.id, addressPath)
      .first<{ id: number; label: string }>();

    if (!account) {
      throw new ApiError(404, 'Wallet not found or does not belong to this user');
    }

    await env.TRADINGBOT_DB
      .prepare('DELETE FROM accounts WHERE id = ?1')
      .bind(account.id)
      .run();

    await dbAddAuditLog(
      env.TRADINGBOT_DB,
      user.id,
      'admin.private_key_deleted',
      addressPath,
      `Deleted managed key '${account.label}'`,
    );

    return jsonResponse({ success: true, message: 'Wallet deleted successfully' }, 200);
  }

  return null;
}
