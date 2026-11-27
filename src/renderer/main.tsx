import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { AuthProvider } from './context/AuthContext';
import { ConfirmProvider } from './context/ConfirmContext';
import './styles/globals.css';
import { applySavedBrand } from './lib/brand';

// The business's colour from the last run, before anything paints (sign-in then confirms it).
applySavedBrand();

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <AuthProvider>
      <ConfirmProvider>
        <App />
      </ConfirmProvider>
    </AuthProvider>
  </React.StrictMode>,
);
