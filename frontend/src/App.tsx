import { Routes, Route, Navigate, Outlet } from "react-router-dom";
import { lazy, Suspense } from "react";
import { Toaster } from "sonner";
import { ThemeProvider } from "./contexts/ThemeContext";
import { LanguageProvider } from "./contexts/LanguageContext";
import { useAuth } from "./hooks/useAuth";
import { PageLoader } from "./components/ui";
import Layout from "./components/Layout";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Machines from "./pages/Machines";
import MachineEnroll from "./pages/MachineEnroll";

// Lazy: heavy pages (>500 LOC or Recharts/diagrams) — benefit the most
// from code-splitting and aren't on the critical path of the first render.
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
    <LanguageProvider>
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
        {/* Eager routes: critical on first render */}
        <Route path="/" element={<Dashboard />} />
        <Route path="/machines" element={<Machines />} />
        <Route path="/machines/new" element={<MachineEnroll />} />
        <Route path="/machines/:id/enroll" element={<MachineEnroll />} />

        {/* Lazy routes: a single <Suspense> via Outlet to share the fallback */}
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
    </LanguageProvider>
  );
}
