# Entire — local development integration

Checked October 30, 2026. Entire supports development evidence; it is not part of the job-verification algorithm. No hosted model, remote repository, Trail, credit purchase or session upload has been run.

## Applied updates

Latest stable [CLI 0.12.2](https://github.com/entireio/cli/releases/tag/v0.12.2), released October 26, is pinned in `scripts/entire.mjs`. The installer verifies the official archive SHA-256 before extracting two executables, and saves a local receipt. Graph **0.6.0** was installed through Entire's checksum-verifying plugin installer. Downloads, plugin data and caches stay under ignored `.tools/`. Setup also copies the verified CLI to `~/.local/bin/entire` when absent, so standard Codex hooks can find it. An existing executable is never overwritten.

The [October 26 launch](https://entire.com/blog/the-git-forge-for-agent-human-collaboration) adds Trails, distributed Git hosting and Continuous Memory. We apply local Graph and Codex checkpoint configuration. The October 27 Appwrite integration and October 28–29 regional hosting additions do not require replacing the agreed Render architecture. Hosted Trails and Brain retrieval remain unverified.

From the application directory, inside an existing Git repository:

```sh
npm run entire:install
npm run entire:setup
npm run entire -- plugin install graph --no-deps
npm run entire -- graph setup --repo . --normal --no-claude-hook
npm run entire:status
npm run entire -- graph doctor --json
npm run entire -- graph query --repo . --profile full --format agent --max-context-bytes 4096 --query "Where is exact ATS job identity verified?"
```

Setup creates no repository or commit. It preserves other integrations and retains Entire's canonical seven hook commands, which its installation and approval checks recognize. The user-local binary directory must already be on the Codex launch environment's PATH. Hooks and capture settings live at the workspace Git root; the app's Graph guide lives in `.entire/agent-guide.md`. Hooks still need Codex's normal approval and a new session; no trust settings are changed.

## Observed evidence

- CLI version and official archive hash verified on macOS arm64.
- Graph doctor reported `no_egress: true`: no remote model, embedding, code fetch, grammar download or telemetry.
- A working-tree query located `scripts/entire.mjs` and backend symbols across 49 files/eight languages. It initially reported degraded coverage: an `App.tsx` parser error at literal `&` text and Git fallback warnings. The JSX was changed to the equivalent `&amp;` entity; a committed-tree recheck is required before claiming the diagnostic cleared. Static call graphs can remain incomplete even after a clean parse.
- Committed-tree indexing and session import need an anchor commit. Setup initially reported that requirement. Subsequent authorized commit/checkpoint outcomes belong in the verification receipt.
- No project-specific speed, token-saving or hosted-review improvement has been measured. Installation alone does not satisfy a sponsor category.

Automatic session pushing and telemetry are disabled. Betterleaks remains enabled; email/phone redaction and image externalization are configured. Redaction is best effort. Images are **not scanned or redacted**. Keep checkpoints local and inspect text and images before separately authorized sharing. [Privacy documentation](https://docs.entire.com/guides/configuration/privacy-and-redaction).

## The $100 credit

The [Billing documentation](https://docs.entire.com/billing) currently says **new-account trial credits are temporarily paused**. Normally a one-time $100 grant starts at billing setup or the first Agents run, whichever comes first, and expires after 90 days or $100 of usage. Preset agents normally need no card; custom agents require one. It funds hosted Agents' token usage, not external provider APIs or a cash reward.

An earlier trial balance can therefore remain legitimate while a fresh signup cannot obtain one today. A person's screenshot does not establish their grant date or mechanism. The specific Billing pause takes precedence over the [pricing page's](https://entire.com/pricing) general trial description. [Credit terms](https://entire.com/credit-terms) limit promotional grants to one per person/business unless approved otherwise.

No Entire balance or grant has been verified for this user. The in-app browser reached the public site, but login failed to load with a connection reset. No card, hosted agent or credit activation was attempted. Once login works, read Account → Billing to verify an existing balance without starting a chargeable run.
