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

# A backstop: export files go after 7 days (the worker deletes them; this catches any it missed).
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
  }
  rule {
    id     = "abandoned-multipart-uploads"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
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

# Only the worker deletes: photos with their incident (retention), export files after 7 days.
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
