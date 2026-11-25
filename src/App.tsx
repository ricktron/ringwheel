import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { DataRoot } from './data/DataRoot';
import { useData } from './data/context';
import { AdminPage } from './pages/AdminPage';
import { ClassesPage } from './pages/ClassesPage';
import { SpinPage } from './pages/SpinPage';

/**
 * The spin and admin pages are rebuilt from scratch whenever the storage mode
 * or the selected class changes. That is what keeps a queue, a history list or
 * an unsaved form from one place from ever showing up in another.
 */
function SpinRoute() {
  const { mode, workspace } = useData();
  return <SpinPage key={`${mode}:${workspace.id}`} />;
}

function AdminRoute() {
  const { mode, workspace } = useData();
  return <AdminPage key={`${mode}:${workspace.id}`} />;
}

function App() {
  return (
    <Router>
      <DataRoot>
        <Routes>
          <Route path="/" element={<Navigate to="/spin" replace />} />
          <Route path="/spin" element={<SpinRoute />} />
          <Route path="/classes" element={<ClassesPage />} />
          <Route path="/admin" element={<AdminRoute />} />
          {/* Any unknown address goes to the spinner instead of a blank page. */}
          <Route path="*" element={<Navigate to="/spin" replace />} />
        </Routes>
      </DataRoot>
    </Router>
  );
}

export default App;
