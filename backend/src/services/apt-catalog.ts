import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import { prisma } from "./database.js";
import { assertSafeOutboundUrl, safeFetch } from "./net-guard.js";

// Ubuntu repos to ingest. Each combination (suite × component × arch) yields one Packages.gz.
interface Source {
  baseUrl: string;
  suite: string;
  component: string;
  arch: string;
}

const DEFAULT_SOURCES: Source[] = [
  // Ubuntu noble (24.04 LTS) main + universe amd64
  { baseUrl: "http://archive.ubuntu.com/ubuntu", suite: "noble", component: "main", arch: "amd64" },
  { baseUrl: "http://archive.ubuntu.com/ubuntu", suite: "noble", component: "universe", arch: "amd64" },
  { baseUrl: "http://archive.ubuntu.com/ubuntu", suite: "noble-updates", component: "main", arch: "amd64" },
  { baseUrl: "http://archive.ubuntu.com/ubuntu", suite: "noble-updates", component: "universe", arch: "amd64" },
  { baseUrl: "http://security.ubuntu.com/ubuntu", suite: "noble-security", component: "main", arch: "amd64" },
];

const BATCH_SIZE = 500;

interface ParsedPackage {
  suite: string;
  component: string;
  arch: string;
  name: string;
  version: string;
  description: string;
  section: string | null;
  size: number | null;
}

// Parse an RFC822 Debian Packages paragraph (blocks separated by "\n\n")
function parseParagraph(para: string, source: Source): ParsedPackage | null {
  const fields = new Map<string, string>();
  let currentKey: string | null = null;
  let currentVal: string[] = [];

  for (const line of para.split("\n")) {
    if (line.startsWith(" ") || line.startsWith("\t")) {
      // Continuation of the previous line
      if (currentKey) currentVal.push(line.trim());
    } else {
      // New key
      if (currentKey) fields.set(currentKey, currentVal.join("\n"));
      const m = line.match(/^([A-Za-z0-9-]+):\s*(.*)$/);
      if (m) {
        currentKey = m[1];
        currentVal = [m[2]];
      } else {
        currentKey = null;
        currentVal = [];
      }
    }
  }
  if (currentKey) fields.set(currentKey, currentVal.join("\n"));

  const name = fields.get("Package");
  const version = fields.get("Version");
  if (!name || !version) return null;

  const description = fields.get("Description") || "";
  const section = fields.get("Section") || null;
  const sizeStr = fields.get("Installed-Size");
  const size = sizeStr ? parseInt(sizeStr, 10) : null;

  return {
    suite: source.suite,
    component: source.component,
    arch: source.arch,
    name,
    version,
    description,
    section,
    size: Number.isFinite(size) ? size : null,
  };
}

async function downloadPackages(source: Source): Promise<string> {
  const url = `${source.baseUrl}/dists/${source.suite}/${source.component}/binary-${source.arch}/Packages.gz`;
  // WEB-AUTHZ-001 — invariant "every outbound URL is validated, no exception":
  // the APT mirror (baseUrl) goes through the same egress guard as webhooks. Blocks
  // private-network / metadata targets even if the surface that defines baseUrl
  // evolves. The defaults (archive/security.ubuntu.com) are public → no impact;
  // an internal mirror (10.x) will be covered by the future operator allow-list.
  assertSafeOutboundUrl(url);
  const res = await safeFetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  if (!res.body) {
    throw new Error("empty body");
  }

  // Stream gzip decompression
  const gunzip = createGunzip();
  const nodeStream = Readable.fromWeb(res.body as any);
  const chunks: string[] = [];
  nodeStream.pipe(gunzip);
  for await (const chunk of gunzip) {
    chunks.push(chunk.toString("utf8"));
  }
  return chunks.join("");
}

async function ingestSource(source: Source): Promise<number> {
  console.log(`[AptCatalog] Fetching ${source.suite}/${source.component}/${source.arch}...`);
  const text = await downloadPackages(source);

  const paragraphs = text.split("\n\n").filter((p) => p.trim().length > 0);
  console.log(`[AptCatalog] Parsing ${paragraphs.length} entries`);

  // Truncate the old ingestion for this source
  await prisma.aptPackage.deleteMany({
    where: { suite: source.suite, component: source.component, arch: source.arch },
  });

  let total = 0;
  let batch: ParsedPackage[] = [];
  for (const para of paragraphs) {
    const pkg = parseParagraph(para, source);
    if (!pkg) continue;
    batch.push(pkg);
    if (batch.length >= BATCH_SIZE) {
      await prisma.aptPackage.createMany({ data: batch, skipDuplicates: true });
      total += batch.length;
      batch = [];
    }
  }
  if (batch.length > 0) {
    await prisma.aptPackage.createMany({ data: batch, skipDuplicates: true });
    total += batch.length;
  }
  console.log(`[AptCatalog] Ingested ${total} packages from ${source.suite}/${source.component}/${source.arch}`);
  return total;
}

let refreshInFlight = false;

export async function refreshAptCatalog(sources: Source[] = DEFAULT_SOURCES): Promise<{ total: number; sources: number }> {
  if (refreshInFlight) {
    console.log("[AptCatalog] Refresh already in progress, skipping");
    return { total: 0, sources: 0 };
  }
  refreshInFlight = true;
  let total = 0;
  let ok = 0;
  try {
    for (const src of sources) {
      try {
        total += await ingestSource(src);
        ok++;
      } catch (err) {
        console.error(`[AptCatalog] Failed ${src.suite}/${src.component}/${src.arch}:`, err);
      }
    }
    console.log(`[AptCatalog] Refresh complete: ${total} packages from ${ok}/${sources.length} sources`);
    return { total, sources: ok };
  } finally {
    refreshInFlight = false;
  }
}

// Triggers the refresh at startup if the table is empty (initial ingestion)
export async function initAptCatalogIfEmpty(): Promise<void> {
  const count = await prisma.aptPackage.count();
  if (count === 0) {
    console.log("[AptCatalog] Empty, triggering initial ingestion in background");
    refreshAptCatalog().catch((err) => console.error("[AptCatalog] Initial refresh failed:", err));
  } else {
    console.log(`[AptCatalog] ${count} packages in DB`);
  }
}
