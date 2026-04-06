import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

const frontendDir = resolve(__dirname, "../../../frontend");

describe("TLS Configuration", () => {
  it("should have nginx HTTP config", () => {
    const path = resolve(frontendDir, "nginx-http.conf");
    expect(existsSync(path)).toBe(true);

    const content = readFileSync(path, "utf8");
    expect(content).toContain("listen 80");
    expect(content).toContain("proxy_pass http://nexus-backend:3000");
    expect(content).toContain("proxy_set_header Upgrade");
    expect(content).not.toContain("ssl_certificate");
  });

  it("should have nginx HTTPS config with TLS settings", () => {
    const path = resolve(frontendDir, "nginx-https.conf");
    expect(existsSync(path)).toBe(true);

    const content = readFileSync(path, "utf8");
    expect(content).toContain("listen 443 ssl");
    expect(content).toContain("ssl_certificate /etc/nginx/certs/nexus.crt");
    expect(content).toContain("ssl_certificate_key /etc/nginx/certs/nexus.key");
    expect(content).toContain("ssl_protocols TLSv1.2 TLSv1.3");
    expect(content).toContain("Strict-Transport-Security");
    expect(content).toContain("return 301 https://");
  });

  it("should have docker entrypoint that handles TLS toggle", () => {
    const path = resolve(frontendDir, "docker-entrypoint.sh");
    expect(existsSync(path)).toBe(true);

    const content = readFileSync(path, "utf8");
    expect(content).toContain("TLS_ENABLED");
    expect(content).toContain("openssl req -x509");
    expect(content).toContain("prime256v1");
    expect(content).toContain("nginx-https.conf");
    expect(content).toContain("nginx-http.conf");
  });

  it("should have Dockerfile with openssl and entrypoint", () => {
    const path = resolve(frontendDir, "Dockerfile");
    expect(existsSync(path)).toBe(true);

    const content = readFileSync(path, "utf8");
    expect(content).toContain("openssl");
    expect(content).toContain("docker-entrypoint.sh");
    expect(content).toContain("EXPOSE 80 443");
  });

  it("should have docker-compose with TLS volumes and ports", () => {
    const path = resolve(__dirname, "../../../docker-compose.yml");
    expect(existsSync(path)).toBe(true);

    const content = readFileSync(path, "utf8");
    expect(content).toContain("TLS_ENABLED");
    expect(content).toContain("443");
    expect(content).toContain("/etc/nginx/certs");
  });
});
