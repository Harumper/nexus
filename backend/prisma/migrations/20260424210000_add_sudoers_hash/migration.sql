-- Detection drift sudoers : l'agent envoie le SHA256 de son fichier
-- /etc/sudoers.d/nexus-agent dans chaque heartbeat. Le backend compare
-- avec la version attendue (extraite de scripts/install-agent.sh).
ALTER TABLE "Machine" ADD COLUMN "sudoersHash" TEXT;
