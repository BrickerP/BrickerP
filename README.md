# Yupeng Lu

**Backend Engineer — live trading systems & AI platforms**

I build live systems and publish the numbers: trading execution on Alpaca, agent platforms at Baidu, and a deterministic 48-second WebGL film with CI performance gates.

- **Live trading execution** — Alpaca bracket orders → shared SQLite execution ledger (fill-dedupe keys, broker + DB startup reconcile) → S3 Parquet → an immutable public dashboard. On 2026-10-08 traced a scan-batch p95 regression (~2.4 s → ~9.2 s) to a 5-minute backfill cron holding SQLite's write lock; removed 2026-10-09, post-fix re-measure pending. → [Technical sheet № 01](https://brickerp.github.io/work/quant/) · [Live dashboard](https://d2c9pzwpavuktk.cloudfront.net/)
- **AI agent platforms at Baidu (MeDo)** — agent-native infra access (coding-agent skill + CLI), release-proof guardrails, Stripe billing-service extraction, 600+ merged changes across 19 repos. → [Resume](https://brickerp.github.io/resume)
- **Beijing Infinite Loop** — deterministic 48-second Three.js film with CI performance and seam gates. → [brickerp.github.io](https://brickerp.github.io/) · [About](https://brickerp.github.io/about/)

[Resume](https://brickerp.github.io/resume) · [Email](mailto:yplmicro@gmail.com) · [LinkedIn](https://linkedin.com/in/yupeng-lu-845a0b411)

<img src="assets/human-zine-cover.svg" width="100%" alt="Yupeng Lu. Field Notes, Issue 00. Things I keep returning to.">

<a href="experiments/README.md"><img src="assets/human-zine-memory.svg" width="100%" alt="Enter the Thought Experiments archive: current experiment 001, A Profile With Memory, and found experiments from before Issue 001."></a>

<a href="experiments/001-a-profile-with-memory/README.md"><img src="https://profile-cards.brickerp.workers.dev/card.svg" width="100%" alt="Live status card rendered at the edge by a Cloudflare Worker: last fill, scan p95, heartbeat, and latest commit. Enter experiment 001, A Profile With Memory."></a>

<a href="https://brickerp.github.io/"><img src="assets/human-zine-film.svg" width="100%" alt="Endless Second Ring, a 48-second Beijing night drive. Open the film."></a>

<a href="https://brickerp.github.io/ai-usage-report/"><img src="assets/human-zine-ai-usage.svg" width="100%" alt="AI Usage, real model history made playable. Open the archive."></a>

<img src="assets/human-zine-process.svg" width="100%" alt="Three independent film design attempts ask what belongs in one scene, beside two attributed rules: film is artistic composition, not navigation; game history pattern is not model capability.">

<a href="mailto:yplmicro@gmail.com"><img src="assets/human-zine-open-line.svg" width="100%" alt="Open a line to email Yupeng Lu."></a>
