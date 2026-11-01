# Render credits and shutdown preparation

**Status, November 1, 2026: prepared and tested locally, not armed. No Vacancy Autopsy Render service exists.** The user requires credits-only hosting. That does not authorize a paid recurring deployment with possible card overages, nor uploading local-only credentials to a new destination.

## Provider limitation

Render documents a spend limit for **build pipeline minutes**, not a workspace-wide compute, disk, or bandwidth cap. Even Free services can generate bandwidth charges when a payment method is present. Suspending compute leaves persistent disks billable. Removing the payment method is not a solution for this paid candidate: Render's terms require a valid payment method while using paid services. Do not remove the card or change settings for the other projects.

The current public OpenAPI specification has no credit-balance, accrued-billing, invoice, or account-spend-limit endpoint. Therefore this preparation does **not** claim automatic authoritative credit monitoring. A manually observed balance can be stale, accrued charges may lag, and the workspace's other services share credits. An estimate based only on this app's $25.25/month is insufficient.

Sources checked November 1:

- [Billing FAQ](https://render.com/docs/faq)
- [Build pipeline limits](https://render.com/docs/build-pipeline)
- [Render's documented suspension and continuing storage charges](https://render.com/docs/deploy-yc-qm)
- [Current public OpenAPI specification](https://api-docs.render.com/v1.0/openapi/render-public-api-1.json)
- [Payment method requirements](https://render.com/terms)
- [Irreversible disk deletion](https://api-docs.render.com/reference/delete-disk)

**Strict zero-card-charge hosting cannot currently be established for this candidate. A software watchdog reduces risk; it is not a provider-enforced credit cap. Paid provisioning remains off.**

## Prepared shutdown tool

[`deploy/render-stop-guard.py`](../deploy/render-stop-guard.py) runs externally, uses only Python's standard library, and defaults to dry-run without reading credentials or contacting Render. It cannot create, deploy, resume, upgrade, or enumerate services. It targets only the bound service ID, expected owner, exact name, repository, and disk ID. All requests use `https://api.render.com/v1`; redirects and arbitrary API paths are refused. Credentials are accepted only through `RENDER_API_KEY`, never command arguments, source, or logs.

A policy must bind actual IDs after a separately approved deployment; placeholders are deliberately not ready to run:

```json
{
  "owner_id": "tea-csp7iobgbbvc73etlgg0",
  "service_id": "REPLACE_WITH_ACTUAL_VACANCY_AUTOPSY_SERVICE_ID",
  "disk_id": "REPLACE_WITH_ITS_ACTUAL_DISK_ID",
  "observed_at": "REPLACE_WITH_CURRENT_UTC_TIME",
  "stop_at": "REPLACE_WITH_SHUTDOWN_TIME_WITHIN_24_HOURS"
}
```

Keep this policy and all billing observations in the ignored workspace `work/` directory. The observation must identify the same workspace and contain `observed_at` and `net_credit_usd`: the current total workspace credit **after accrued usage**, not this project's estimated allowance. If the dashboard cannot establish that amount, leave the observation unavailable. Never fabricate it or infer a live balance from the original $50 award.

The tool triggers a stop when:

- the maximum 24-hour lease expires;
- the billing observation is missing, invalid, from another workspace, in the future, or older than 15 minutes;
- net workspace credit reaches the fixed $10 reserve.

This policy is intentionally conservative. A future scheduler would need fresh authoritative observations; no such data source or independent scheduled execution has been verified or activated. A sleeping laptop, scheduler delay, provider outage, or lagging billing can defeat timely stopping. A hard deadline is an additional trigger, not proof of a maximum invoice.

From the application directory, a no-network preview is:

```sh
python3 deploy/render-stop-guard.py --policy /ABSOLUTE/IGNORED/PATH/policy.json
```

Only after the separate credential/destination and stop authorization, `--apply-suspend` sends the suspension request and polls for its actual state. An accepted HTTP 202 alone does not count as success. A timeout or failed identity check reports **stop not verified**. The normal result explicitly says `disk: preserved_and_billable`, never that all costs stopped.

## Disk retirement is separate and irreversible

The tool also prepares an explicitly selected `--retire-disk EXACT_DISK_ID --backup-receipt /PRIVATE/PATH/receipt.json` path, together with `--apply-suspend`. Do not arm this path without scoped deletion authorization. It confirms suspension, reads the exact disk and service relationship, verifies size and mount path, checks a local backup's hash and private file permissions, deletes only that disk, and verifies its absence. Repeating a completed retirement does not delete anything else.

Before retirement, stop initiating model requests, settle or record in-flight/uncertain submissions, quiesce writers, export **all** `/var/lib/vacancy-autopsy/priority` state while the service remains accessible, and verify a restore into an isolated directory. Do not submit predictions during restore verification. Store the export with owner-only permissions outside Git. Record an owner-reviewed receipt:

```json
{
  "service_id": "EXACT_SERVICE_ID",
  "disk_id": "EXACT_DISK_ID",
  "writers_quiesced": true,
  "observed_at": "CURRENT_UTC_TIME",
  "archive_path": "/ABSOLUTE/IGNORED/PRIVATE/BACKUP.tar",
  "sha256": "SHA256_OF_THAT_ARCHIVE"
}
```

The receipt must be at most 15 minutes old. A checksum proves local file integrity; the operator must independently establish backup completeness and quiescence. **A live export/restore has not been exercised because there is no deployed service.** If backup verification fails, compute is suspended but the disk is preserved and remains billable. This is deliberately not described as complete credit protection.

Reports, captured artifacts, and approvals stay in Atlas, which this tool never modifies. Pending TabPFN operation state lives on the disk; preserve its export and restore it before any future ranking. Do not recreate an empty state directory and resubmit uncertain operations.

## Validation and activation boundary

Run `python3 -m unittest discover -s deploy -p 'test_*.py' -v`. The shutdown tests use synthetic API responses and local temporary backups; they cover unknown/stale credits, deadlines, wrong resources, unverified suspension, tampered or unsafe backups, explicit disk retirement, repeated retirement, transport failure, and redirect rejection. They are not hosted-provider proof.

Before any activation, obtain approval for the exact recurring resource and its residual billing risk, the Render destination of project secrets, hosted Auth0/Atlas access, independent scheduling credentials, and the precise disk retirement action. Bind real IDs, exercise an authorized disposable live resource, verify backup/restore and actual shutdown, and keep auto-deploy off. Until then, the tested code is preparation only and the credits-only deployment gate remains closed.
