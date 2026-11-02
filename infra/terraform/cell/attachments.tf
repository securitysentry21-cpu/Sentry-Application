# Incident photos (ARCH §12, SEC §12): a private bucket. The phone uploads an original through a link
# the API signs (PUT, at most 15 minutes, the exact type and length, never over an existing object);
# the worker checks it and writes the view copy without metadata; the dashboard reads through links
# of at most 5 minutes. No public access, TLS only, encrypted with our key, objects owned by the bucket.
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

resource "aws_s3_bucket_policy" "attachments" {
  bucket     = aws_s3_bucket.attachments.id
  policy     = data.aws_iam_policy_document.attachments_bucket.json
  depends_on = [aws_s3_bucket_public_access_block.attachments]
}

# The api signs the links (a signed link acts with the signer's permissions); the worker reads the
# original and writes the view copy. Objects only, under org/ (storage/objects.ts builds every key).
data "aws_iam_policy_document" "attachments_access" {
  statement {
    sid       = "Objects"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.attachments.arn}/org/*"]
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
