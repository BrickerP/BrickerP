// `wrangler types` only emits bindings declared in wrangler.jsonc; the admin
// token is a secret, so it is declared here and merged into the generated Env.
interface Env {
	ADMIN_TOKEN?: string;
}

declare namespace Cloudflare {
	interface Env {
		ADMIN_TOKEN?: string;
	}
}
