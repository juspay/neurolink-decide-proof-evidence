# Fixture audit

Made by `tests/runner/make-fake-audit.mjs` against `runner/fake-provider.mjs`. Every number here comes from a fake provider and means nothing.
The secrets are fake values in `tests/fixtures/fake-env/`; the planted one is echoed by the fake provider so masking can be checked.
Rebuilding replaces this folder (timestamps and the port in the config change).
