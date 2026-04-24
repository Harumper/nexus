-- CreateTable
CREATE TABLE "AptPackage" (
    "id" TEXT NOT NULL,
    "suite" TEXT NOT NULL,
    "component" TEXT NOT NULL,
    "arch" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "section" TEXT,
    "size" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AptPackage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AptPackage_suite_component_arch_name_key"
    ON "AptPackage"("suite", "component", "arch", "name");

-- CreateIndex
CREATE INDEX "AptPackage_name_idx" ON "AptPackage"("name");

-- CreateIndex
CREATE INDEX "AptPackage_suite_idx" ON "AptPackage"("suite");

-- Add generated tsvector column for FTS (name weight A, description weight B)
ALTER TABLE "AptPackage"
    ADD COLUMN "searchVector" tsvector
    GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce(name, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(description, '')), 'B')
    ) STORED;

-- GIN index for full-text search
CREATE INDEX "AptPackage_searchVector_idx" ON "AptPackage" USING GIN ("searchVector");
