import { Routes, Route } from 'react-router-dom'
import AppShell from './components/AppShell.jsx'
import UploadPage from './pages/Upload/UploadPage.jsx'
import ProcessingPage from './pages/Processing/ProcessingPage.jsx'
import ThemesPage from './pages/Themes/ThemesPage.jsx'
import ThemeDetailPage from './pages/ThemeDetail/ThemeDetailPage.jsx'
import TicketsPage from './pages/Tickets/TicketsPage.jsx'
import AuditPage from './pages/Audit/AuditPage.jsx'

export default function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<UploadPage />} />
        <Route path="/runs/:runId" element={<ProcessingPage />} />
        <Route path="/runs/:runId/themes" element={<ThemesPage />} />
        <Route path="/themes/:themeId" element={<ThemeDetailPage />} />
        <Route path="/runs/:runId/tickets" element={<TicketsPage />} />
        <Route path="/runs/:runId/audit" element={<AuditPage />} />
      </Routes>
    </AppShell>
  )
}
