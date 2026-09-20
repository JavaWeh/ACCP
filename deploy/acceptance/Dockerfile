FROM mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27
RUN apt-get update && apt-get install -y --no-install-recommends libnss3-tools && rm -rf /var/lib/apt/lists/*
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY web/playwright.oidc.config.ts ./
COPY web/tests/oidc.spec.ts ./tests/oidc.spec.ts
COPY web/tests/oidc-lifecycle.spec.ts ./tests/oidc-lifecycle.spec.ts
COPY web/tests/oidc-collaboration.spec.ts ./tests/oidc-collaboration.spec.ts
# Trust only inside this disposable test container, never in the host certificate store.
CMD ["/bin/sh", "-ec", "mkdir -p /root/.pki/nssdb; certutil -N --empty-password -d sql:/root/.pki/nssdb; certutil -A -d sql:/root/.pki/nssdb -n accp-acceptance -t C,, -i /fixture/tls/ca.pem; npx playwright test --config playwright.oidc.config.ts"]
