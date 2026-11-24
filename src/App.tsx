import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { SpinPage } from './pages/SpinPage';
import { AdminPage } from './pages/AdminPage';

function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<Navigate to="/spin" replace />} />
        <Route path="/spin" element={<SpinPage />} />
        <Route path="/admin" element={<AdminPage />} />
        {/* Any unknown address goes to the spinner instead of a blank page. */}
        <Route path="*" element={<Navigate to="/spin" replace />} />
      </Routes>
    </Router>
  );
}

export default App;
