import type { Env } from '../workerShared';
import {
  base58Encode,
} from '../workerCore';
import {
  dbLoadManagedKeypairBytesByAccountId,
} from '../userStore';
import { ApiError } from '../errors';

export interface ActiveSigningAccount {
  id: number;
  label: string;
  publicKey: string;
  privateKeyBytes: Uint8Array;
  privateKeyBase58: string;
  createdAt: number;
}

export async function getActiveAccounts(
  env: Env,
  userId: number,
): Promise<ActiveSigningAccount[]> {
  if (!env.PRIVATE_KEY_ENCRYPTION_KEY) {
    throw new ApiError(
      503,
      'PRIVATE_KEY_ENCRYPTION_KEY is not configured — cannot decrypt active signing accounts',
    );
  }

  const rows = await env.TRADINGBOT_DB
    .prepare(
      `SELECT
         id,
         label,
         wallet_address,
         created_at
       FROM accounts
       WHERE user_id = ?1
         AND type = 'managed'
         AND COALESCE(is_active, 1) = 1
         AND encrypted_private_key IS NOT NULL
       ORDER BY created_at ASC, id ASC`,
    )
    .bind(userId)
    .all<{
      id: number;
      label: string;
      wallet_address: string;
      created_at: number;
    }>();

  return Promise.all(
    rows.results.map(async (row) => {
      const privateKeyBytes = await dbLoadManagedKeypairBytesByAccountId(
        env.TRADINGBOT_DB,
        userId,
        row.id,
        env.PRIVATE_KEY_ENCRYPTION_KEY!,
      );
      return {
        id: row.id,
        label: row.label,
        publicKey: row.wallet_address,
        privateKeyBytes,
        privateKeyBase58: base58Encode(privateKeyBytes),
        createdAt: row.created_at,
      };
    }),
  );
}