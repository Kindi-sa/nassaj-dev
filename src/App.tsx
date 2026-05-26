import { BrowserRouter as Router, Route, Routes } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import { ThemeProvider } from './contexts/ThemeContext';
import { RtlProvider } from './contexts/RtlContext';
import { AuthProvider, ProtectedRoute } from './components/auth';
import JoinPage from './components/auth/view/JoinPage';
import { TaskMasterProvider } from './contexts/TaskMasterContext';
import { TasksSettingsProvider } from './contexts/TasksSettingsContext';
import { WebSocketProvider } from './contexts/WebSocketContext';
import { PluginsProvider } from './contexts/PluginsContext';
import AppContent from './components/app/AppContent';
import i18n from './i18n/config.js';

// The authenticated application shell. Everything here sits behind
// ProtectedRoute (login gate + onboarding) and the realtime/data providers.
function AuthenticatedApp() {
  return (
    <WebSocketProvider>
      <PluginsProvider>
        <TasksSettingsProvider>
          <TaskMasterProvider>
            <ProtectedRoute>
              <Routes>
                <Route path="/" element={<AppContent />} />
                <Route path="/session/:sessionId" element={<AppContent />} />
              </Routes>
            </ProtectedRoute>
          </TaskMasterProvider>
        </TasksSettingsProvider>
      </PluginsProvider>
    </WebSocketProvider>
  );
}

export default function App() {
  return (
    <I18nextProvider i18n={i18n}>
      <ThemeProvider>
        <RtlProvider>
          <AuthProvider>
            <Router basename={window.__ROUTER_BASENAME__ || ''}>
              <Routes>
                {/* Public invite-acceptance route — must bypass the auth gate. */}
                <Route path="/join" element={<JoinPage />} />
                {/* Everything else is gated behind authentication. */}
                <Route path="/*" element={<AuthenticatedApp />} />
              </Routes>
            </Router>
          </AuthProvider>
        </RtlProvider>
      </ThemeProvider>
    </I18nextProvider>
  );
}
