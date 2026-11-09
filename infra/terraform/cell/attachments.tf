# Incident photos (ARCH §12, SEC §12) and export files (PROD §15.2): a private bucket. The phone
# uploads an original through a link the API signs (PUT, at most 15 minutes, the exact type and
# length, never over an existing object); the worker checks it and writes the view copy without
# metadata; the dashboard reads through links of at most 5 minutes (15 for an export). The worker
# writes export files under exports/ and deletes them after 7 days, and deletes photos with their
# incident (retention, SEC §16.5). No public access, TLS only, encrypted with our key, objects owned
# by the bucket.
resource "aws_s3_bucket" "attachments" {
  bucket = "${local.name}-attachments-${local.account_id}"
}

resource "aws_s3_bucket_public_access_block" "attachments" {
  bucket                  = aws_s3_bucket.attachments.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "attachments" {
  bucket = aws_s3_bucket.attachments.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "attachments" {
  bucket = aws_s3_bucket.attachments.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.main.arn
    }
    # One data key for the bucket rather than one per object: far fewer KMS requests.
    bucket_key_enabled = true
  }
}

data "aws_iam_policy_document" "attachments_bucket" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.attachments.arn, "${aws_s3_bucket.attachments.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

# Review L-03, ARCH §19.6 and §19.8: versioned, so an object overwritten or deleted by mistake, by a
# bug or by a stolen API role (it must hold PutObject to sign uploads) is still there as an older
# version. Older versions last as long as database backups do (db_backup_retention_days: 35 in
# production, SEC §16 "backups expire within the backup retention period"), so a photo retention
# deletes is gone from every copy by then. This is not Object Lock: someone holding the bucket's
# own administrator rights can still remove versions (docs/DECISIONS.md, review L-03).
resource "aws_s3_bucket_versioning" "attachments" {
  bucket = aws_s3_bucket.attachments.id
  versioning_configuration {
    status = "Enabled"
  }
}

# Export files go after 7 days (the worker deletes them; this rule catches any it missed), and their
# older versions after a day: they hold location history. Every other older version goes with the
# backup window, and a delete marker with nothing left behind it is cleared.
resource "aws_s3_bucket_lifecycle_configuration" "attachments" {
  bucket = aws_s3_bucket.attachments.id
  rule {
    id     = "export-files-backstop"
    status = "Enabled"
    filter {
      prefix = "exports/"
    }
    expiration {
      days = 8
    }
    noncurrent_version_expiration {
      noncurrent_days = 1
    }
  }
  rule {
    id     = "older-versions-with-the-backups"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = var.db_backup_retention_days
    }
    expiration {
      expired_object_delete_marker = true
    }
  }
  rule {
    id     = "abandoned-multipart-uploads"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
  depends_on = [aws_s3_bucket_versioning.attachments]
}

resource "aws_s3_bucket_policy" "attachments" {
  bucket     = aws_s3_bucket.attachments.id
  policy     = data.aws_iam_policy_document.attachments_bucket.json
  depends_on = [aws_s3_bucket_public_access_block.attachments]
}

# The api signs the links (a signed link acts with the signer's permissions); the worker reads the
# original, writes the view copy and the export files. Objects only, under org/ and exports/
# (storage/objects.ts and services/exports.ts build every key).
data "aws_iam_policy_document" "attachments_access" {
  statement {
    sid       = "Objects"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.attachments.arn}/org/*", "${aws_s3_bucket.attachments.arn}/exports/*"]
  }
  statement {
    sid       = "Encryption"
    actions   = ["kms:GenerateDataKey", "kms:Decrypt"]
    resources = [aws_kms_key.main.arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["s3.${var.region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "attachments" {
  for_each = toset(["api", "worker"])
  name     = "attachments"
  role     = aws_iam_role.task[each.key].id
  policy   = data.aws_iam_policy_document.attachments_access.json
}

# Only the worker deletes: photos with their incident (retention), export files after 7 days. A
# delete without a version leaves a delete marker; no task role may remove a version
# (s3:DeleteObjectVersion), only the lifecycle rules above.
data "aws_iam_policy_document" "attachments_delete" {
  statement {
    sid       = "Delete"
    actions   = ["s3:DeleteObject"]
    resources = ["${aws_s3_bucket.attachments.arn}/org/*", "${aws_s3_bucket.attachments.arn}/exports/*"]
  }
}

resource "aws_iam_role_policy" "attachments_delete" {
  name   = "attachments-delete"
  role   = aws_iam_role.task["worker"].id
  policy = data.aws_iam_policy_document.attachments_delete.json
}

# --- The copy in the backup region (ARCH §19.8: "files replicated to eu-west-1"), with
# backup_copy_enabled (production). Photos only (org/): export files are 7-day downloads. Retention's
# deletions travel too (delete markers), and the copy's older versions expire on the same clock, so
# the copy never outlives what SEC §16 promises. Encrypted with the backup region's key.

resource "aws_s3_bucket" "attachments_copy" {
  count    = var.backup_copy_enabled ? 1 : 0
  provider = aws.backup
  bucket   = "${local.name}-attachments-copy-${local.account_id}"
}

resource "aws_s3_bucket_versioning" "attachments_copy" {
  count    = var.backup_copy_enabled ? 1 : 0
  provider = aws.backup
  bucket   = aws_s3_bucket.attachments_copy[0].id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "attachments_copy" {
  count                   = var.backup_copy_enabled ? 1 : 0
  provider                = aws.backup
  bucket                  = aws_s3_bucket.attachments_copy[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "attachments_copy" {
  count    = var.backup_copy_enabled ? 1 : 0
  provider = aws.backup
  bucket   = aws_s3_bucket.attachments_copy[0].id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "attachments_copy" {
  count    = var.backup_copy_enabled ? 1 : 0
  provider = aws.backup
  bucket   = aws_s3_bucket.attachments_copy[0].id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.backup[0].arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_policy" "attachments_copy" {
  count    = var.backup_copy_enabled ? 1 : 0
  provider = aws.backup
  bucket   = aws_s3_bucket.attachments_copy[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.attachments_copy[0].arn, "${aws_s3_bucket.attachments_copy[0].arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
  depends_on = [aws_s3_bucket_public_access_block.attachments_copy]
}

resource "aws_s3_bucket_lifecycle_configuration" "attachments_copy" {
  count    = var.backup_copy_enabled ? 1 : 0
  provider = aws.backup
  bucket   = aws_s3_bucket.attachments_copy[0].id
  rule {
    id     = "older-versions-with-the-backups"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = var.db_backup_retention_days
    }
    expiration {
      expired_object_delete_marker = true
    }
  }
  depends_on = [aws_s3_bucket_versioning.attachments_copy]
}

resource "aws_iam_role" "attachments_replication" {
  count = var.backup_copy_enabled ? 1 : 0
  name  = "${local.name}-attachments-replication"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "s3.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = { StringEquals = { "aws:SourceAccount" = local.account_id } }
    }]
  })
}

# Read the source's versions, write replicas: nothing else, and no deletes beyond markers.
data "aws_iam_policy_document" "attachments_replication" {
  count = var.backup_copy_enabled ? 1 : 0
  statement {
    sid       = "SourceBucket"
    actions   = ["s3:GetReplicationConfiguration", "s3:ListBucket"]
    resources = [aws_s3_bucket.attachments.arn]
  }
  statement {
    sid       = "SourceVersions"
    actions   = ["s3:GetObjectVersionForReplication", "s3:GetObjectVersionAcl", "s3:GetObjectVersionTagging"]
    resources = ["${aws_s3_bucket.attachments.arn}/org/*"]
  }
  statement {
    sid       = "Replicas"
    actions   = ["s3:ReplicateObject", "s3:ReplicateDelete", "s3:ReplicateTags"]
    resources = ["${aws_s3_bucket.attachments_copy[0].arn}/org/*"]
  }
  statement {
    sid       = "DecryptSource"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.main.arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["s3.${var.region}.amazonaws.com"]
    }
  }
  statement {
    sid       = "EncryptReplica"
    actions   = ["kms:Encrypt", "kms:GenerateDataKey"]
    resources = [aws_kms_key.backup[0].arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["s3.${var.backup_region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "attachments_replication" {
  count  = var.backup_copy_enabled ? 1 : 0
  name   = "replication"
  role   = aws_iam_role.attachments_replication[0].id
  policy = data.aws_iam_policy_document.attachments_replication[0].json
}

resource "aws_s3_bucket_replication_configuration" "attachments" {
  count  = var.backup_copy_enabled ? 1 : 0
  bucket = aws_s3_bucket.attachments.id
  role   = aws_iam_role.attachments_replication[0].arn
  rule {
    id     = "photos-to-the-backup-region"
    status = "Enabled"
    filter {
      prefix = "org/"
    }
    delete_marker_replication {
      status = "Enabled"
    }
    source_selection_criteria {
      sse_kms_encrypted_objects {
        status = "Enabled"
      }
    }
    destination {
      bucket = aws_s3_bucket.attachments_copy[0].arn
      encryption_configuration {
        replica_kms_key_id = aws_kms_key.backup[0].arn
      }
    }
  }
  depends_on = [aws_s3_bucket_versioning.attachments, aws_s3_bucket_versioning.attachments_copy]
}
