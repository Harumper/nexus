-- Badge "MAJ dispo" flotte-wide : l'agent envoie le SHA256 de son binaire
-- en cours d'execution dans chaque heartbeat. Le backend compare avec le
-- SHA du binaire qu'il sert pour savoir si une mise a jour de l'agent est
-- disponible, sans avoir a ouvrir le detail de chaque machine.
ALTER TABLE "Machine" ADD COLUMN "agentSha256" TEXT;
