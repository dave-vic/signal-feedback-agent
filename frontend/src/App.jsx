import { Routes, Route } from 'react-router-dom'
import AppShell from './components/AppShell.jsx'
import UploadPage from './pages/Upload/UploadPage.jsx'
import ProcessingPage from './pages/Processing/ProcessingPage.jsx'

export default function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<UploadPage />} />
        <Route path="/runs/:runId" element={<ProcessingPage />} />
      </Routes>
    </AppShell>
  )
}
