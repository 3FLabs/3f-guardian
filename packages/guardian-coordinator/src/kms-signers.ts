import { secp256k1 } from "@noble/curves/secp256k1";
import { Result } from "better-result";
import {
  hashTypedData,
  hexToBytes,
  recoverAddress,
  keccak256,
  parseSignature,
  serializeTransaction,
  type Address,
  type Hex,
  type LocalAccount,
} from "viem";
import { toAccount } from "viem/accounts";

import { InternalError, UpstreamUnavailableError, type SignTypedData } from "@3flabs/guardian";

type BytesLike = Uint8Array | string;

export type AwsKmsDigestSigner = (args: { keyId: string; digest: Hex }) => Promise<BytesLike>;

export type GcpKmsDigestSigner = (args: {
  keyVersionName: string;
  digest: Hex;
}) => Promise<BytesLike>;

export function awsKmsSignTypedData(args: {
  keyId: string;
  guardianSigner: Address;
  region?: string | undefined;
  signDigest?: AwsKmsDigestSigner;
}): SignTypedData {
  const signDigest = args.signDigest ?? awsSignDigest(args);
  return kmsSignTypedData({
    label: "AWS KMS",
    guardianSigner: args.guardianSigner,
    signDigest: (digest) => signDigest({ keyId: args.keyId, digest }),
  });
}

export function gcpKmsSignTypedData(args: {
  keyVersionName: string;
  guardianSigner: Address;
  signDigest?: GcpKmsDigestSigner;
}): SignTypedData {
  const signDigest = args.signDigest ?? gcpSignDigest();
  return kmsSignTypedData({
    label: "GCP KMS",
    guardianSigner: args.guardianSigner,
    signDigest: (digest) => signDigest({ keyVersionName: args.keyVersionName, digest }),
  });
}

function kmsSignTypedData(args: {
  label: string;
  guardianSigner: Address;
  signDigest: (digest: Hex) => Promise<BytesLike>;
}): SignTypedData {
  const { label, guardianSigner, signDigest } = args;
  return async (parameters) => {
    const digest = hashTypedData(parameters);
    let derSignature: Uint8Array;
    try {
      derSignature = bytesLikeToUint8Array(await signDigest(digest));
    } catch (cause) {
      const error = new UpstreamUnavailableError({
        message: `${label} sign request failed`,
        status: 503,
      });
      error.cause = cause;
      return Result.err(error);
    }

    try {
      return Result.ok(
        await ethereumSignatureFromDer({
          digest,
          derSignature,
          guardianSigner,
        }),
      );
    } catch (cause) {
      const error = new InternalError({ message: `${label} signature was not usable` });
      error.cause = cause;
      return Result.err(error);
    }
  };
}

export async function ethereumSignatureFromDer(args: {
  digest: Hex;
  derSignature: Uint8Array;
  guardianSigner: Address;
}): Promise<Hex> {
  const compact = secp256k1.Signature.fromDER(args.derSignature).normalizeS().toCompactHex();

  for (const yParity of [0, 1] as const) {
    const v = (27 + yParity).toString(16).padStart(2, "0");
    const signature = `0x${compact}${v}` as Hex;
    const recovered = await recoverAddress({ hash: args.digest, signature });
    if (recovered.toLowerCase() === args.guardianSigner.toLowerCase()) return signature;
  }

  throw new Error("KMS signature did not recover to GUARDIAN_SIGNER_ADDRESS");
}

function awsSignDigest(args: { region?: string | undefined }): AwsKmsDigestSigner {
  let deps:
    | Promise<{
        client: { send(command: unknown): Promise<{ Signature?: BytesLike }> };
        SignCommand: new (input: {
          KeyId: string;
          Message: Uint8Array;
          MessageType: "DIGEST";
          SigningAlgorithm: "ECDSA_SHA_256";
        }) => unknown;
      }>
    | undefined;

  return async ({ keyId, digest }) => {
    deps ??= import("@aws-sdk/client-kms").then((mod) => ({
      client: new mod.KMSClient(args.region ? { region: args.region } : {}),
      SignCommand: mod.SignCommand,
    }));
    const { client, SignCommand } = await deps;
    const response = await client.send(
      new SignCommand({
        KeyId: keyId,
        Message: hexToBytes(digest),
        MessageType: "DIGEST",
        SigningAlgorithm: "ECDSA_SHA_256",
      }),
    );
    if (!response.Signature) throw new Error("AWS KMS Sign response missing Signature");
    return response.Signature;
  };
}

function gcpSignDigest(): GcpKmsDigestSigner {
  let client:
    | Promise<{
        asymmetricSign(request: {
          name: string;
          digest: { sha256: Uint8Array };
        }): Promise<readonly [{ signature?: BytesLike | null } | undefined, ...unknown[]]>;
      }>
    | undefined;

  return async ({ keyVersionName, digest }) => {
    client ??= import("@google-cloud/kms").then((mod) => new mod.KeyManagementServiceClient());
    const [response] = await (
      await client
    ).asymmetricSign({
      name: keyVersionName,
      digest: { sha256: hexToBytes(digest) },
    });
    if (!response?.signature) throw new Error("GCP KMS Sign response missing signature");
    return response.signature;
  };
}

function bytesLikeToUint8Array(value: BytesLike): Uint8Array {
  if (value instanceof Uint8Array) return value;
  return Uint8Array.from(Buffer.from(value, "base64"));
}

export function gcpKmsAccount(args: {
  keyVersionName: string;
  guardianSigner: Address;
  signDigest?: GcpKmsDigestSigner;
}): LocalAccount {
  const sign = args.signDigest ?? gcpSignDigest();
  return kmsAccount(args.guardianSigner, (digest) =>
    sign({ keyVersionName: args.keyVersionName, digest }),
  );
}

export function awsKmsAccount(args: {
  keyId: string;
  guardianSigner: Address;
  region?: string | undefined;
  signDigest?: AwsKmsDigestSigner;
}): LocalAccount {
  const sign = args.signDigest ?? awsSignDigest(args);
  return kmsAccount(args.guardianSigner, (digest) => sign({ keyId: args.keyId, digest }));
}

function kmsAccount(
  guardianSigner: Address,
  signDigest: (digest: Hex) => Promise<BytesLike>,
): LocalAccount {
  const sign = async (digest: Hex) =>
    ethereumSignatureFromDer({
      digest,
      guardianSigner,
      derSignature: bytesLikeToUint8Array(await signDigest(digest)),
    });
  return toAccount({
    address: guardianSigner,
    signMessage: async () => {
      throw new Error("Guardian does not sign arbitrary messages");
    },
    signTypedData: async (data) => sign(hashTypedData(data)),
    signTransaction: async (transaction) =>
      serializeTransaction(
        transaction,
        parseSignature(await sign(keccak256(serializeTransaction(transaction)))),
      ),
  });
}
