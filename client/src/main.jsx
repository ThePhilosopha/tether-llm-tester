import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';
import './assets/icon.svg';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
);