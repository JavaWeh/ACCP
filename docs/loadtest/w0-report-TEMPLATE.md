# W0 load test report (template)

- Date: YYYY-MM-DD
- Origin: `http://127.0.0.1:PORT`
- Duration / concurrency / event samples: …
- Wall clock: …s
- Result: PASS | FAIL
- JSON evidence: `.accp-local/m3-loadtest/report-….json`

| metric | measured | W0 target | met/not-met |
| --- | --- | --- | --- |
| API read P95 | … ms | < 300 ms | met / not-met |
| API write P95 | … ms | < 800 ms | met / not-met |
| Event visibility P95 | … ms | < 2000 ms | met / not-met |
| API 5xx rate | …% | < 0.1% | met / not-met |

Pool samples: acquired … / max … (wait not exposed by `/metrics` today).

## Bottleneck notes

- (fill only when any row is not-met; cite pool / queries / event loop — no architecture rewrite)

Scope: synthetic W0-oriented mix; not a full 50-user / 200-session seed unless explicitly stated.

## How to run

```sh
node scripts/loadtest-w0.mjs \
  --origin http://127.0.0.1:18080 \
  --credentials .accp-local/dev-users.json \
  --duration-sec 120 \
  --concurrency 8 \
  --event-samples 5 \
  --metrics-url http://127.0.0.1:19091/metrics \
  --output-dir .accp-local/m3-loadtest
```
