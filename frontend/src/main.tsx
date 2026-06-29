import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { AuthProvider } from "./hooks/useAuth";
import App from "./App";
import "./i18n";
import "./index.css";

// Après un déploiement, un onglet déjà ouvert peut tenter de charger un chunk
// hashé qui n'existe plus (404) → "Failed to fetch dynamically imported module".
// On recharge alors la page pour récupérer le nouvel index.html et ses chunks.
// Garde anti-boucle : pas plus d'un reload toutes les 10 s.
window.addEventListener("vite:preloadError", () => {
  const KEY = "nexus_last_chunk_reload";
  const last = Number(sessionStorage.getItem(KEY) || 0);
  if (Date.now() - last < 10_000) return;
  sessionStorage.setItem(KEY, String(Date.now()));
  window.location.reload();
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>
);
