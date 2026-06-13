import { Routes, Route } from 'react-router-dom'
import UploadPage from './pages/Upload/UploadPage.jsx'
import ProcessingPlaceholder from './pages/ProcessingPlaceholder.jsx'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<UploadPage />} />
      <Route path="/runs/:runId" element={<ProcessingPlaceholder />} />
    </Routes>
  )
}
