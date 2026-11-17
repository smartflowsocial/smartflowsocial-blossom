# Blossom R2 readiness

`GET /health` only shows that the process is up. `GET /ready` also checks the database, object
storage, the SmartFlowSocial policy endpoint, and the uncommitted-blob backlog.

Storage is ready when `HeadObject` for `__readiness_probe__` succeeds or when R2 says that object is
missing. A missing probe is a successful API response. It is not a reason to return HTTP 503.

These storage failures stay HTTP 503 and set `checks.storageError`:

| `storageError`  | Meaning                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `access_denied` | The API answered 401 or 403, or the SDK reported invalid credentials or access denied.                                    |
| `timeout`       | The probe exceeded 2.5 seconds.                                                                                           |
| `network`       | DNS or the connection to the R2 endpoint failed.                                                                          |
| `unavailable`   | Any other storage error. The response does not include the SDK message, because that message can contain the bucket name. |

`NODE_ENV=test` does not skip this check.

## Live observation on 17 November 2026

`https://blossom-api.smartflow.social/health` returned HTTP 200.

`https://blossom-api.smartflow.social/ready` returned HTTP 503:

```json
{
  "status": "not_ready",
  "checks": {
    "db": true,
    "storage": false,
    "pendingCommits": 0,
    "deadLetterCommits": 0,
    "policy": "ok"
  }
}
```

That response has no `storageError` field, so it came from a build that records only success or
failure. In the source that build corresponds to, `storage: false` means `HeadObject` threw.
`NotFound` and `NoSuchKey` do not throw. The database and the policy check were healthy, and the
failure returned in well under a second.

This workspace has no production R2 credentials, so the exact R2 error is **unverified**. Two
explanations still fit:

1. R2 rejected the call. A fast 403 is the usual result of a token that cannot read the bucket, a
   wrong endpoint, or a wrong key.
2. R2 returned 404 with an error name other than `NotFound` or `NoSuchKey`. The AWS SDK sometimes
   reports an empty HEAD body as `Unknown` with HTTP 404. That case is now treated as a missing
   probe.

Deploying this change does not make `/ready` return 200 by itself. If the token is denied, the next
response stays 503 and `checks.storageError` is `access_denied`.

## Operator check

Run this from a shell that already has the production R2 variables. Do not print
`R2_SECRET_ACCESS_KEY`.

```bash
curl -sS -D - https://blossom-api.smartflow.social/ready
curl -sS https://blossom-api.smartflow.social/health

aws s3api head-bucket \
  --bucket "$R2_BUCKET" \
  --endpoint-url "$R2_ENDPOINT"

aws s3api head-object \
  --bucket "$R2_BUCKET" \
  --key __readiness_probe__ \
  --endpoint-url "$R2_ENDPOINT"
```

`head-bucket` or `head-object` returning `404` / `Not Found` means the credentials reached the
bucket and the probe object is absent. Readiness treats that as storage up.

`403` or `InvalidAccessKeyId` means the token cannot perform the call. Create an R2 API token with
Object Read and Object Write on `R2_BUCKET`, and set `R2_ENDPOINT` to
`https://<account-id>.r2.cloudflarestorage.com`. The S3 region in this service is `auto`.

Disposable upload, read, and delete:

```bash
KEY="readiness-check-$(date +%s).txt"
printf 'smartflow readiness check\n' | aws s3 cp - "s3://$R2_BUCKET/$KEY" \
  --endpoint-url "$R2_ENDPOINT"
aws s3api head-object \
  --bucket "$R2_BUCKET" \
  --key "$KEY" \
  --endpoint-url "$R2_ENDPOINT"
aws s3api delete-object \
  --bucket "$R2_BUCKET" \
  --key "$KEY" \
  --endpoint-url "$R2_ENDPOINT"
```

The AWS CLI needs `AWS_ACCESS_KEY_ID=$R2_ACCESS_KEY_ID` and
`AWS_SECRET_ACCESS_KEY=$R2_SECRET_ACCESS_KEY`. This repository does not contain those values, and
this check was not run against production.
