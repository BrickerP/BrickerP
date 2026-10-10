declare module "cloudflare:test" {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface ProvidedEnv extends Env {}
}

declare module "*/public/chain.js" {
  export const GENESIS_HASH: string;
  export function canonicalJSON(value: unknown): string;
  export function sha256Hex(input: string): Promise<string>;
  export function hashPreimage(prevHash: string, event: unknown): string;
  export function computeHash(prevHash: string, event: unknown): Promise<string>;
  export function stripChain(chained: Record<string, unknown>): Record<string, unknown>;
  export function createVerifier(
    expectedPrev?: string,
    expectedSeq?: number,
  ): {
    step(chained: Record<string, unknown>): Promise<boolean>;
    result(): {
      ok: boolean;
      checked: number;
      lastHash: string | null;
      nextSeq: number;
      failure: { seq: number; reason: string } | null;
    };
  };
}
