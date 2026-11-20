import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './index.css';
import { AuthProvider } from './context/AuthContext.jsx';
import { CopilotProvider } from './context/CopilotContext.jsx';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AuthProvider>
      <CopilotProvider>
        <App />
      </CopilotProvider>
    </AuthProvider>
  </React.StrictMode>
);
