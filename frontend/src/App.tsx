import { Routes, Route, Navigate } from "react-router-dom";
import { Toaster } from "sonner";
import { ThemeProvider } from "./contexts/ThemeContext";
import { useAuth } from "./hooks/useAuth";
import Layout from "./components/Layout";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Machines from "./pages/Machines";
import MachineDetail from "./pages/MachineDetail";
import Alerts from "./pages/Alerts";
import AuditLog from "./pages/AuditLog";
import Containers from "./pages/Containers";
import Tags from "./pages/Tags";
import Settings from "./pages/Settings";
import Profiles from "./pages/Profiles";
import Compare from "./pages/Compare";
import Docs from "./pages/Docs";
import MachineEnroll from "./pages/MachineEnroll";

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
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
        <Route path="/" element={<Dashboard />} />
        <Route path="/machines" element={<Machines />} />
        <Route path="/machines/new" element={<MachineEnroll />} />
        <Route path="/machines/:id/enroll" element={<MachineEnroll />} />
        <Route path="/machines/:id" element={<MachineDetail />} />
        <Route path="/alerts" element={<Alerts />} />
        <Route path="/tags" element={<Tags />} />
        <Route path="/audit" element={<AuditLog />} />
        <Route path="/containers" element={<Containers />} />
        <Route path="/profiles" element={<Profiles />} />
        <Route path="/compare" element={<Compare />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/docs" element={<Docs />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </ThemeProvider>
  );
}
