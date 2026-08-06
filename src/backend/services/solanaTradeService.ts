import nacl from 'tweetnacl';

import { solanaRpc } from '../workerCore';

function readCompactU16(bytes: Uint8Array, offset: number): [number, number] {
  let val = 0;
  let shift = 0;
  let bytesRead = 0;
  while (offset + bytesRead < bytes.length) {
    const byte = bytes[offset + bytesRead];
    bytesRead += 1;
    val |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  return [val, bytesRead];
}

export function signSolanaTransaction(
  txBytes: Uint8Array,
  signerKeypair: Uint8Array,
): Uint8Array {
  const [sigCount, sigCountLen] = readCompactU16(txBytes, 0);
  if (sigCount === 0) throw new Error('Transaction has no signature slots');
  const messageOffset = sigCountLen + sigCount * 64;
  const messageBytes = txBytes.slice(messageOffset);
  const signature = nacl.sign.detached(messageBytes, signerKeypair);
  const signed = new Uint8Array(txBytes);
  signed.set(signature, sigCountLen);
  return signed;
}

export async function sendSolanaTransaction(
  rpcUrls: string | string[],
  signedTxBytes: Uint8Array,
): Promise<string> {
  let binary = '';
  signedTxBytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  const base64Tx = btoa(binary);
  return solanaRpc<string>(rpcUrls, 'sendTransaction', [
    base64Tx,
    { encoding: 'base64', preflightCommitment: 'confirmed' },
  ]);
}
