import { Routes, Route } from 'react-router-dom'
import AppShell from './components/AppShell.jsx'
import UploadPage from './pages/Upload/UploadPage.jsx'
import ProcessingPlaceholder from './pages/ProcessingPlaceholder.jsx'

export default function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<UploadPage />} />
        <Route path="/runs/:runId" element={<ProcessingPlaceholder />} />
      </Routes>
    </AppShell>
  )
}
