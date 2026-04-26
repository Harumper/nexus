import { Routes, Route, Navigate, Outlet } from "react-router-dom";
import { lazy, Suspense } from "react";
import { Toaster } from "sonner";
import { ThemeProvider } from "./contexts/ThemeContext";
import { useAuth } from "./hooks/useAuth";
import { PageLoader } from "./components/ui";
import Layout from "./components/Layout";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Machines from "./pages/Machines";
import MachineEnroll from "./pages/MachineEnroll";

// Lazy : pages lourdes (>500 LOC ou Recharts/diagrammes) — bénéficient le plus
// du code-split et ne sont pas sur le chemin critique du premier rendu.
const MachineDetail = lazy(() => import("./pages/MachineDetail"));
const Docs = lazy(() => import("./pages/Docs"));
const AlertCreate = lazy(() => import("./pages/AlertCreate"));
const AuditLog = lazy(() => import("./pages/AuditLog"));
const Containers = lazy(() => import("./pages/Containers"));
const Compare = lazy(() => import("./pages/Compare"));
const Alerts = lazy(() => import("./pages/Alerts"));
const Settings = lazy(() => import("./pages/Settings"));

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, loading } = useAuth();

  if (loading) {
    return <PageLoader />;
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}

export default function App() {
  const { isAuthenticated } = useAuth();

  return (
    <ThemeProvider>
    <Toaster
      position="top-right"
      theme="system"
      richColors
      closeButton
      toastOptions={{
        classNames: {
          toast: "!bg-card !border-border !text-foreground",
        },
      }}
    />
    <Routes>
      <Route
        path="/login"
        element={
          isAuthenticated ? <Navigate to="/" replace /> : <Login />
        }
      />
      <Route
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        {/* Routes eager : critiques au premier rendu */}
        <Route path="/" element={<Dashboard />} />
        <Route path="/machines" element={<Machines />} />
        <Route path="/machines/new" element={<MachineEnroll />} />
        <Route path="/machines/:id/enroll" element={<MachineEnroll />} />

        {/* Routes lazy : un seul <Suspense> via Outlet pour partager le fallback */}
        <Route element={<Suspense fallback={<PageLoader />}><Outlet /></Suspense>}>
          <Route path="/machines/:id" element={<MachineDetail />} />
          <Route path="/alerts" element={<Alerts />} />
          <Route path="/alerts/new" element={<AlertCreate />} />
          <Route path="/alerts/:id/edit" element={<AlertCreate />} />
          <Route path="/audit" element={<AuditLog />} />
          <Route path="/containers" element={<Containers />} />
          <Route path="/compare" element={<Compare />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/docs" element={<Docs />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </ThemeProvider>
  );
}
