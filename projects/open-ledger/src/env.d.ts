// `wrangler types` generates `Env` from wrangler.jsonc (LEDGER, ASSETS) and from .dev.vars when
// present. The ingest secret lives outside the config, so declare it here as well; identical
// declarations merge cleanly whether or not .dev.vars exists.
interface Env {
  INGEST_TOKEN: string;
}

declare namespace Cloudflare {
  interface Env {
    INGEST_TOKEN: string;
  }
}
