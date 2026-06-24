-- Alerte sur la posture de durcissement : se declenche quand l'indice Lynis
-- du dernier scan d'une machine passe sous le seuil (rule.threshold).
ALTER TYPE "AlertConditionType" ADD VALUE 'HARDENING_INDEX_BELOW';
