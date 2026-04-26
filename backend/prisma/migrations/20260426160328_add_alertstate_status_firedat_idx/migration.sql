-- Index composite pour les listings d'alertes actives triées
-- (queries WHERE status IN (FIRING, ACKNOWLEDGED) ORDER BY firedAt DESC)
CREATE INDEX "AlertState_status_firedAt_idx" ON "AlertState"("status", "firedAt" DESC);
