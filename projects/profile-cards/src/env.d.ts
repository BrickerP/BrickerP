// Secrets are not part of wrangler.jsonc, so `wrangler types` cannot know
// about them. Declare them here so `env.GITHUB_TOKEN` type-checks.
interface Env {
  GITHUB_TOKEN?: string;
}
