import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { AuthProvider } from "./hooks/useAuth";
import App from "./App";
import "./i18n";
import "./index.css";

// After a deployment, an already-open tab may try to load a hashed chunk
// that no longer exists (404) → "Failed to fetch dynamically imported module".
// We then reload the page to fetch the new index.html and its chunks.
// Anti-loop guard: no more than one reload every 10s.
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
