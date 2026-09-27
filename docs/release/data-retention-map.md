# Data retention map

Generated from `apps/api/src/modules/data_governance/registry.rs`, which is the
authority. `apps/api/src/modules/data_governance/tests.rs` asserts the class set,
and `security::data_retention_map` in the API crate asserts that this file names
exactly the classes the registry declares, so this table cannot silently drift from
the code.

**85 declared classes.** Every attribute is required — there is no
`Option` and no default on `DataClassRecord` — so "declared" is a property of the
type rather than a review convention. A class that is not in this table is a class
nothing reasons about, which is why the count is asserted and not merely observed.

## Reading the columns

- **Sensitivity** — drives redaction. `Restricted` and `Confidential` are redacted
  in an export; `Internal` is included.
- **Owner** — `Organization` means one tenant owns the row. `Device` means it hangs
  off a device and is collected through the device. `Principal` means it belongs to
  a user across every organization they were ever in, which is why those reads are
  principal-scoped rather than org-scoped.
- **Default retention** — `lifecycle` means the row lives until the owner or a
  deletion request removes it. `baseline <name>` is one of the frozen windows in
  `modules/data_governance/retention.rs`; `bounded`/`anchored` are explicit
  durations. The **legal maximum** is a separate column in the registry and is
  enforced by `retention::decide`: a tenant policy that asks for more needs an
  audited override.
- **Deletion** — `Tombstone` keeps the row with identifiers replaced; `Purge`
  removes it. A class with a legal/security duty is retained past deletion and
  says so in the registry.
- **Logging** — the most a log line may ever say about this class. `MetadataOnly`
  and `StatusOnly` carry no content; `IdsStatus` carries identifiers and a status
  and nothing else. This is the column that makes "never log sensitive prompts"
  checkable rather than aspirational.

## The table

| Class | Sensitivity | Owner | Default retention | Export | Deletion | Logging |
|---|---|---|---|---|---|---|
| `automation_definition` | Internal | Organization | `lifecycle` | Included | Tombstone | MetadataOnly |
| `schedule_rule` | Internal | Organization | `lifecycle` | Included | Tombstone | MetadataOnly |
| `occurrence` | Internal | Organization | `baseline AutomationProjection` | Included | Tombstone | StatusOnly |
| `execution_lease` | Restricted | Device | `baseline AutomationProjection` | Redacted | Tombstone | StatusOnly |
| `occurrence_attempt` | Confidential | Organization | `baseline AutomationProjection` | Redacted | Tombstone | StatusOnly |
| `automation_run_link` | Internal | Organization | `baseline AutomationProjection` | Redacted | Tombstone | IdsStatus |
| `webhook_endpoint` | Confidential | Organization | `lifecycle` | Sanitized | Tombstone | StatusOnly |
| `webhook_secret` | Secret | Organization | `lifecycle` | Never | CryptoErase | IdsStatus |
| `webhook_delivery` | Internal | Organization | `baseline DeliveryProjection` | Sanitized | Tombstone | StatusOnly |
| `webhook_delivery_attempt` | Internal | Organization | `baseline DeliveryProjection` | Sanitized | Tombstone | StatusOnly |
| `notification_preference` | Internal | User | `lifecycle` | OwnerExport | Tombstone | StatusOnly |
| `notification` | Confidential | User | `baseline DeliveryProjection` | OwnerExport | Tombstone | MetadataOnly |
| `notification_delivery` | Internal | User | `baseline DeliveryProjection` | OwnerExport | Tombstone | StatusOnly |
| `plan` | Internal | Platform | `lifecycle` | Sanitized | RetainLegalOnly | StatusOnly |
| `plan_entitlement` | Internal | Platform | `lifecycle` | Sanitized | RetainLegalOnly | StatusOnly |
| `billing_account` | Restricted | Organization | `lifecycle` | Redacted | Tombstone | StatusOnly |
| `subscription` | Confidential | Organization | `baseline FinancialRecord` | Redacted | Minimize | StatusOnly |
| `subscription_event` | Confidential | Organization | `baseline FinancialRecord` | Redacted | Minimize | StatusOnly |
| `provider_entitlement_projection` | Internal | Organization | `anchored: Anchor::LastObservation` | Sanitized | Tombstone | StatusOnly |
| `entitlement_definition` | Internal | Platform | `lifecycle` | Sanitized | Revoke | StatusOnly |
| `entitlement_grant` | Confidential | Organization | `anchored: Anchor::EntitlementGrantExpiry` | Sanitized | Revoke | StatusOnly |
| `license_snapshot` | Restricted | Organization | `baseline LicenseEntitlementMetadata` | Sanitized | Tombstone | StatusOnly |
| `license_state` | Restricted | Organization | `baseline LicenseEntitlementMetadata` | Sanitized | Tombstone | StatusOnly |
| `license_signing_key` | Restricted | Platform | `lifecycle` | Sanitized | Tombstone | IdsStatus |
| `data_governance_policy` | Confidential | Organization | `lifecycle` | Included | Tombstone | MetadataOnly |
| `data_class_registry` | Internal | Platform | `lifecycle` | Included | Tombstone | MetadataOnly |
| `service_account` | Confidential | Organization | `lifecycle` | MetadataOnly | Revoke | IdsStatus |
| `api_key` | Secret | Organization | `lifecycle` | Never | CryptoErase | IdsStatus |
| `api_key_fingerprint` | Internal | Organization | `baseline AccessGrant` | MetadataOnly | PhysicalDelete | IdsStatus |
| `plugin_package` | Public | Platform | `lifecycle` | Included | Tombstone | MetadataOnly |
| `plugin_version` | Internal | Platform | `lifecycle` | Included | Tombstone | MetadataOnly |
| `plugin_install` | Internal | Organization | `lifecycle` | Included | Tombstone | IdsStatus |
| `plugin_policy` | Internal | Organization | `lifecycle` | Included | Tombstone | MetadataOnly |
| `plugin_tool_registration` | Internal | Organization | `lifecycle` | Included | Tombstone | IdsStatus |
| `plugin_quarantine` | Internal | Platform | `lifecycle` | MetadataOnly | RetainLegalOnly | IdsStatus |
| `staff_principal` | Restricted | Platform | `lifecycle` | Never | Tombstone | IdsStatus |
| `support_grant` | Restricted | Platform | `lifecycle` | Never | RetainLegalOnly | IdsStatus |
| `feature_flag` | Internal | Platform | `lifecycle` | MetadataOnly | Tombstone | MetadataOnly |
| `kill_switch` | Internal | Platform | `lifecycle` | MetadataOnly | RetainLegalOnly | IdsStatus |
| `export_job` | Confidential | Organization | `baseline ExportJobMetadata` | MetadataOnly | Tombstone | StatusOnly |
| `export_artifact` | Restricted | Organization | `baseline ExportArtifact` | Sanitized | PhysicalDelete | StatusOnly |
| `export_download_grant` | Confidential | User | `baseline AccessGrant` | MetadataOnly | Tombstone | StatusOnly |
| `deletion_job` | Confidential | Organization | `baseline ExportJobMetadata` | Redacted | Tombstone | StatusOnly |
| `deletion_step` | Confidential | Organization | `baseline DeletionStep` | Redacted | Tombstone | StatusOnly |
| `deletion_certificate` | Restricted | Organization | `baseline DeletionCertificate` | Redacted | RetainLegalOnly | StatusOnly |
| `queue_job_envelope` | Internal | Organization | `baseline QueueJobProjection` | Never | Tombstone | StatusOnly |
| `provider_sync_state` | Confidential | Organization | `anchored: Anchor::RequestAccepted` | MetadataOnly | Tombstone | StatusOnly |
| `idempotency_record` | Confidential | Organization | `anchored: Anchor::RequestAccepted` | Never | Tombstone | StatusOnly |
| `identity` | Restricted | User | `lifecycle` | OwnerExport | Tombstone | IdsStatus |
| `login_session` | Restricted | User | `lifecycle` | Never | Tombstone | IdsStatus |
| `passkey_authenticator` | Restricted | User | `lifecycle` | OwnerExport | CryptoErase | IdsStatus |
| `organization` | Internal | Organization | `lifecycle` | Included | Tombstone | MetadataOnly |
| `membership` | Confidential | Organization | `lifecycle` | Included | Tombstone | StatusOnly |
| `invitation` | Confidential | Organization | `lifecycle` | Included | Tombstone | StatusOnly |
| `team_member` | Internal | Organization | `lifecycle` | Included | Tombstone | StatusOnly |
| `project_access_grant` | Confidential | Organization | `lifecycle` | Included | Tombstone | StatusOnly |
| `team` | Internal | Organization | `lifecycle` | Included | Tombstone | MetadataOnly |
| `device_enrollment` | Confidential | Device | `lifecycle` | Redacted | Tombstone | IdsStatus |
| `device` | Confidential | Device | `lifecycle` | Redacted | Tombstone | IdsStatus |
| `workspace_binding` | Confidential | Device | `lifecycle` | Redacted | Tombstone | IdsStatus |
| `provider` | Internal | Platform | `lifecycle` | Sanitized | Tombstone | StatusOnly |
| `model` | Internal | Platform | `lifecycle` | Included | Tombstone | StatusOnly |
| `model_route` | Internal | Organization | `lifecycle` | Redacted | Tombstone | StatusOnly |
| `credential` | Restricted | Organization | `lifecycle` | Redacted | Revoke | IdsStatus |
| `policy_snapshot` | Internal | Organization | `lifecycle` | Redacted | Tombstone | StatusOnly |
| `policy_ack` | Internal | Device | `lifecycle` | Redacted | Tombstone | StatusOnly |
| `tool_policy` | Confidential | Organization | `lifecycle` | Redacted | Tombstone | StatusOnly |
| `inference_request` | Confidential | Project | `lifecycle` | Redacted | Minimize | StatusOnly |
| `usage_event` | Confidential | Project | `baseline FinancialRecord` | Included | Minimize | StatusOnly |
| `cost_record` | Confidential | Organization | `baseline FinancialRecord` | Included | Minimize | StatusOnly |
| `budget` | Internal | Project | `lifecycle` | Included | Tombstone | StatusOnly |
| `rate_limit_policy` | Internal | Organization | `lifecycle` | Included | Tombstone | StatusOnly |
| `agent_definition` | Confidential | Project | `lifecycle` | Included | Tombstone | MetadataOnly |
| `agent_session` | Confidential | Project | `lifecycle` | Included | Tombstone | MetadataOnly |
| `run` | Confidential | Project | `lifecycle` | Included | Tombstone | MetadataOnly |
| `run_event` | Confidential | Project | `lifecycle` | Included | Tombstone | MetadataOnly |
| `tool_call` | Confidential | Project | `lifecycle` | Redacted | Tombstone | StatusOnly |
| `approval_request` | Confidential | Project | `lifecycle` | Redacted | Tombstone | StatusOnly |
| `artifact_ref` | Restricted | Project | `lifecycle` | Sanitized | Tombstone | StatusOnly |
| `artifact` | Restricted | Project | `lifecycle` | Sanitized | PhysicalDelete | StatusOnly |
| `audit_security_event` | Restricted | Platform | `baseline AuditSecurityEvent` | Redacted | RetainLegalOnly | IdsStatus |
| `outbox_event` | Internal | Organization | `baseline QueueJobProjection` | Never | Tombstone | StatusOnly |
| `upstream_provider_data` | Confidential | External | `anchored: Anchor::LastObservation` | Sanitized | RetainLegalOnly | StatusOnly |
| `secret` | Secret | Organization | `lifecycle` | Never | CryptoErase | None |
| `operational_log` | Confidential | Platform | `baseline OperationalLog` | Never | PhysicalDelete | MetadataOnly |

## What this does not decide

- **Upstream retention.** A BYOK credential does not imply zero retention at the
  provider. F20 requires the UI and docs to distinguish Lumi retention from the
  provider's data-use policy, and that disclosure is a product surface, not a
  registry value.
- **Backup rewriting.** Deletion propagates to the backup lifecycle on schedule.
  Backups are not selectively rewritten when that is operationally unsafe, so a
  deleted row can persist in a backup until that backup expires. This is stated
  rather than hidden, and it bounds the real deletion guarantee to the backup
  retention window.
