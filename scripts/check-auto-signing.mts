import assert from 'node:assert/strict';

import {
  Keypair,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import nacl from 'tweetnacl';

import { signVersionedTransaction } from '../src/backend/services/jupiterSwapService.ts';

function buildTransferTransaction(signer: Keypair): VersionedTransaction {
  const recipient = Keypair.generate().publicKey;
  const message = new TransactionMessage({
    payerKey: signer.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [
      SystemProgram.transfer({
        fromPubkey: signer.publicKey,
        toPubkey: recipient,
        lamports: 1,
      }),
    ],
  }).compileToV0Message();
  return new VersionedTransaction(message);
}

function assertValidSignature(
  transaction: VersionedTransaction,
  signer: Keypair,
): void {
  const signature = transaction.signatures[0];
  assert.ok(signature, 'signed transaction should include the fee-payer signature');
  assert.equal(
    nacl.sign.detached.verify(
      transaction.message.serialize(),
      signature,
      signer.publicKey.toBytes(),
    ),
    true,
    'transaction signature should verify against the managed wallet public key',
  );
}

const signer = Keypair.generate();
const secretKeyTransaction = buildTransferTransaction(signer);
signVersionedTransaction(secretKeyTransaction, {
  publicKey: signer.publicKey.toBase58(),
  privateKey: signer.secretKey,
});
assertValidSignature(secretKeyTransaction, signer);

const seedTransaction = buildTransferTransaction(signer);
signVersionedTransaction(seedTransaction, {
  publicKey: signer.publicKey.toBase58(),
  privateKey: signer.secretKey.slice(0, 32),
});
assertValidSignature(seedTransaction, signer);

assert.throws(
  () =>
    signVersionedTransaction(buildTransferTransaction(signer), {
      publicKey: Keypair.generate().publicKey.toBase58(),
      privateKey: signer.secretKey,
    }),
  /Signing key does not match managed wallet/,
  'a decrypted key must not sign for a different managed wallet address',
);

console.log('Auto-signing check passed. Seed and secret-key signatures verify, and wallet mismatches are rejected.');
