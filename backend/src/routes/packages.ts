import type { FastifyInstance } from "fastify";
import { prisma } from "../services/database.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { refreshAptCatalog } from "../services/apt-catalog.js";

interface PackageSearchResult {
  name: string;
  version: string;
  description: string;
  section: string | null;
  size: number | null;
  suite: string;
  component: string;
  arch: string;
  rank: number;
}

export async function packagesRoutes(app: FastifyInstance): Promise<void> {
  // Recherche FTS dans le catalogue
  app.get(
    "/api/packages/search",
    {
      preHandler: [requireAuth],
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const q = ((request.query as any).q || "").trim();
      const suite = (request.query as any).suite || "noble";
      const arch = (request.query as any).arch || "amd64";
      const limit = Math.min(parseInt((request.query as any).limit || "50", 10), 200);

      if (!q || q.length < 2) {
        return reply.send({ results: [], query: q });
      }

      // Query FTS avec ranking. On prefixe pour permettre l'autocomplete partiel.
      // plainto_tsquery gere les caracteres speciaux. Pour prefix search, on ajoute :* sur le dernier mot.
      const tsQuery = q
        .split(/\s+/)
        .filter((t: string) => t.length > 0)
        .map((t: string) => t.replace(/[^a-zA-Z0-9_-]/g, "") + ":*")
        .filter((t: string) => t.length > 2)
        .join(" & ");

      if (!tsQuery) {
        return reply.send({ results: [], query: q });
      }

      const results = await prisma.$queryRawUnsafe<PackageSearchResult[]>(
        `SELECT
           name, version, description, section, size, suite, component, arch,
           ts_rank_cd("searchVector", to_tsquery('english', $1)) AS rank
         FROM "AptPackage"
         WHERE suite LIKE $2
           AND arch = $3
           AND "searchVector" @@ to_tsquery('english', $1)
         ORDER BY rank DESC, name ASC
         LIMIT $4`,
        tsQuery,
        suite + "%", // match noble, noble-updates, noble-security
        arch,
        limit
      );

      return reply.send({
        query: q,
        suite,
        arch,
        count: results.length,
        results: results.map((r) => ({
          ...r,
          rank: undefined,
        })),
      });
    }
  );

  // Liste des suites disponibles (pour dropdown)
  app.get(
    "/api/packages/suites",
    { preHandler: [requireAuth] },
    async (_request, reply) => {
      const suites = await prisma.$queryRaw<{ suite: string }[]>`
        SELECT DISTINCT suite FROM "AptPackage" ORDER BY suite
      `;
      return reply.send({ suites: suites.map((s) => s.suite) });
    }
  );

  // Trigger refresh manuel (admin only)
  app.post(
    "/api/packages/refresh",
    { preHandler: [requireAdmin] },
    async (_request, reply) => {
      refreshAptCatalog().catch((err) =>
        console.error("[AptCatalog] Refresh error:", err)
      );
      return reply.code(202).send({ success: true, message: "Refresh started in background" });
    }
  );
}
